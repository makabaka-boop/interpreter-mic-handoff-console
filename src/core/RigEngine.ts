/**
 * RigEngine —— 主/备麦克风切换校验的全部业务规则。
 *
 * 不变式：
 * 1. 每次试听、武装、切换都递增代次（generation）；异步 await 回来后必须核对代次，
 *    较早代次拿到的流立即 stop，且不得改写提示。
 * 2. 切换时备用流就绪前主路持续输出；就绪后做 80ms 线性增减益交叉，再停止旧轨道。
 * 3. 候选被拒、候选提前结束、AudioContext.resume 失败：保留原主路。
 * 4. 活动主路一旦结束即进入故障态；切换中迟到的候选也要释放；重新试听后方可武装。
 * 5. 停止 = 释放全部流与节点，麦克风占用状态不得残留。
 *
 * 引擎只依赖构造时注入的浏览器能力，不包含任何假接口；测试通过替身驱动。
 */

import type {
  ChannelPhase,
  ChannelSnapshot,
  DeviceItem,
  EngineMessage,
  LiveLine,
  PermissionStateKind,
  RigEnv,
  RigPhase,
  RigSnapshot,
  Role,
} from './types';

export const CROSSFADE_MS = 80;

interface ChannelState {
  role: Role;
  phase: ChannelPhase;
  deviceId: string | null;
  auditionedDeviceId: string | null;
  active: boolean;
  level: number;
}

const FALLBACK_LABEL: Record<Role, string> = {
  primary: '主输入',
  backup: '备输入',
};

export class RigEngine {
  private env: RigEnv;
  private listeners = new Set<() => void>();
  private emitScheduled = false;

  private generation = 0;
  private permission: PermissionStateKind = 'idle';
  private phase: RigPhase = 'idle';

  private channels: Record<Role, ChannelState> = {
    primary: this.blankChannel('primary'),
    backup: this.blankChannel('backup'),
  };

  private devices: DeviceItem[] = [];
  private messages: EngineMessage[] = [];
  private messageSeq = 0;

  private lines = new Map<Role | 'candidate', LiveLine>();
  private candidate: LiveLine | null = null;
  private crossfadeTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: AudioContext | null = null;
  private rafId: number | null = null;
  private levelBuf: Uint8Array | null = null;

  private deviceChangeListener: (() => void) | null = null;

  /**
   * 快照缓存：useSyncExternalStore 要求 getSnapshot 在两次通知之间返回
   * 引用稳定的值，否则会无限重渲染。仅在 emit 通知时失效重算。
   */
  private snapshotCache: RigSnapshot | null = null;

  constructor(env?: Partial<RigEnv>) {
    const navMedia =
      typeof navigator !== 'undefined' && navigator.mediaDevices
        ? navigator.mediaDevices
        : null;
    const Ctor =
      typeof window !== 'undefined'
        ? window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext ??
          null
        : null;
    this.env = {
      mediaDevices: env?.mediaDevices === undefined ? navMedia : env.mediaDevices,
      AudioContextCtor:
        env?.AudioContextCtor === undefined ? Ctor : env.AudioContextCtor,
      isSecureContext:
        env?.isSecureContext === undefined
          ? typeof window !== 'undefined'
            ? window.isSecureContext
            : false
          : env.isSecureContext,
    };

    if (!this.env.mediaDevices) {
      this.permission = 'unsupported';
      this.phase = 'no-support';
      this.note('error', this.unsupportedReason());
    }
  }

  private blankChannel(role: Role): ChannelState {
    return {
      role,
      phase: 'idle',
      deviceId: null,
      auditionedDeviceId: null,
      active: false,
      level: 0,
    };
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    this.snapshotCache = null;
    for (const fn of this.listeners) fn();
  }

  /** 电平表每帧调用，合并到一次微任务，避免一帧多次通知 */
  private emitSoon(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      this.emit();
    });
  }

  getSnapshot = (): RigSnapshot => {
    if (this.snapshotCache) return this.snapshotCache;
    this.snapshotCache = this.computeSnapshot();
    return this.snapshotCache;
  };

  private computeSnapshot(): RigSnapshot {
    const primary = this.channelSnapshot('primary');
    const backup = this.channelSnapshot('backup');
    const micInUse = this.lines.size > 0;
    return {
      phase: this.phase,
      permission: this.permission,
      isSecureContext: this.env.isSecureContext,
      hasWebAudio: this.env.AudioContextCtor !== null,
      primary,
      backup,
      devices: this.devices,
      micInUse,
      messages: this.messages,
      can: {
        requestPermission:
          this.permission !== 'unsupported' &&
          (this.permission === 'idle' || this.permission === 'denied'),
        auditionPrimary: this.canAudition('primary'),
        auditionBackup: this.canAudition('backup'),
        arm:
          this.permission === 'granted' &&
          this.phase === 'idle' &&
          this.channels.primary.phase === 'live-audition' &&
          this.channels.backup.phase === 'live-audition' &&
          this.channels.primary.auditionedDeviceId !== null &&
          this.channels.backup.auditionedDeviceId !== null,
        switch: this.phase === 'armed',
        stop:
          this.lines.size > 0 ||
          this.phase === 'arming' ||
          this.phase === 'armed' ||
          this.phase === 'switching' ||
          this.phase === 'running-backup' ||
          this.phase === 'fault',
      },
    };
  };

  private channelSnapshot(role: Role): ChannelSnapshot {
    const c = this.channels[role];
    const line = this.lines.get(role);
    return {
      role: c.role,
      phase: c.phase,
      deviceId: c.deviceId,
      auditionedDeviceId: c.auditionedDeviceId,
      active: c.active,
      level: line ? c.level : 0,
    };
  }

  private canAudition(role: Role): boolean {
    if (this.permission !== 'granted') return false;
    if (this.phase === 'no-support') return false;
    if (this.phase === 'arming' || this.phase === 'armed') return false;
    if (this.phase === 'switching') return false;
    if (this.phase === 'running-backup') return false;
    if (this.channels[role].phase === 'auditioning') return false;
    return this.channels[role].deviceId !== null;
  }

  // ---------------------------------------------------------------- 提示

  private note(kind: EngineMessage['kind'], text: string): void {
    this.messages = [
      ...this.messages.slice(-29),
      { id: ++this.messageSeq, kind, text },
    ];
  }

  // ---------------------------------------------------------------- 授权

  /**
   * 用户手势触发：申请一次仅音频的权限，并枚举设备。
   * 用真实 getUserMedia 做权限探针（无假接口）；拿到后立刻停止探针轨道，
   * 再 enumerateDevices，此时 label 可见。
   */
  async requestPermission(): Promise<void> {
    const md = this.env.mediaDevices;
    if (!md) {
      this.permission = 'unsupported';
      this.phase = 'no-support';
      this.note('error', this.unsupportedReason());
      this.emit();
      return;
    }
    if (this.permission === 'granted') {
      await this.refreshDevices();
      this.emit();
      return;
    }

    const gen = ++this.generation;
    this.permission = 'prompting';
    this.note('info', '正在请求麦克风授权…');
    this.emit();

    let probe: MediaStream | null = null;
    try {
      probe = await md.getUserMedia({
        audio: { echoCancellation: false },
        video: false,
      });
      if (gen !== this.generation) {
        // 授权弹窗期间发生了更新的操作：探针立即关闭，不写状态
        this.stopStream(probe);
        return;
      }
      this.permission = 'granted';
      this.stopStream(probe);
      probe = null;
      await this.refreshDevices();
      this.attachDeviceChangeListener();
      this.note('success', '麦克风授权成功，已读取设备列表。');
      this.emit();
    } catch (err) {
      if (gen !== this.generation) {
        if (probe) this.stopStream(probe);
        return;
      }
      this.permission = 'denied';
      this.note('error', this.describeMediaError(err, '授权失败'));
      this.emit();
    }
  }

  private attachDeviceChangeListener(): void {
    if (this.deviceChangeListener || !this.env.mediaDevices) return;
    this.deviceChangeListener = () => {
      void this.refreshDevices();
    };
    this.env.mediaDevices.addEventListener(
      'devicechange',
      this.deviceChangeListener,
    );
  }

  private async refreshDevices(): Promise<void> {
    const md = this.env.mediaDevices;
    if (!md) return;
    try {
      const all = await md.enumerateDevices();
      this.devices = all
        .filter((d): d is MediaDeviceInfo & { deviceId: string } =>
          d.kind === 'audioinput' && !!d.deviceId,
        )
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `音频输入设备（${d.deviceId.slice(0, 8)}…）`,
        }));
    } catch {
      // 枚举失败不清空已工作的线路，也不清空已有列表
      this.note('warn', '设备列表刷新失败，保留现有选择。');
    }
    this.emitSoon();
  }

  // ---------------------------------------------------------------- 试听

  /**
   * 选择设备（仅记录，不触碰麦克风）。武装/切换中禁止改动。
   */
  selectDevice(role: Role, deviceId: string): void {
    if (
      this.phase === 'arming' ||
      this.phase === 'armed' ||
      this.phase === 'switching'
    ) {
      this.note('warn', '武装或切换进行中，不能更改设备选择。');
      this.emit();
      return;
    }
    const c = this.channels[role];
    c.deviceId = deviceId;
    if (c.auditionedDeviceId !== deviceId) {
      c.auditionedDeviceId = null;
    }
    this.emit();
  }

  /**
   * 试听某一路：申请该设备流 -> resume 上下文 -> 建 source/gain/analyser -> 耳返。
   * 重复点击每次都递增代次：旧代次 await 回来的流立即停止，不覆盖提示。
   */
  async audition(role: Role): Promise<void> {
    const readyReason = this.ensureReady();
    if (readyReason) {
      this.note('error', readyReason);
      this.emit();
      return;
    }
    const c = this.channels[role];
    if (
      this.phase === 'arming' ||
      this.phase === 'armed' ||
      this.phase === 'switching' ||
      this.phase === 'running-backup'
    ) {
      this.note('warn', this.phaseBlockReason());
      this.emit();
      return;
    }
    if (!c.deviceId) {
      this.note('error', `请先选择${FALLBACK_LABEL[role]}设备。`);
      this.emit();
      return;
    }
    if (
      this.devices.length > 0 &&
      !this.devices.some((d) => d.deviceId === c.deviceId)
    ) {
      this.note('error', `${FALLBACK_LABEL[role]}设备不存在，请重新选择。`);
      this.emit();
      return;
    }

    const gen = ++this.generation;
    // 从故障态发起试听即退出故障态（线路此前已全部释放）
    const cameFromFault = this.phase === 'fault';
    if (cameFromFault) this.phase = 'idle';
    c.phase = 'auditioning';
    this.note('info', `正在打开${FALLBACK_LABEL[role]}试听…`);
    this.emit();

    // 关旧路：主路试听不承担“活动主输出”，武装时才加冕
    this.releaseLine(role);

    let stream: MediaStream | null = null;
    try {
      const md = this.env.mediaDevices;
      if (!md || !this.env.AudioContextCtor) {
        throw new Error(this.unsupportedReason());
      }
      stream = await md.getUserMedia({
        audio: { deviceId: { exact: c.deviceId }, echoCancellation: false },
        video: false,
      });
      if (gen !== this.generation) {
        this.stopStream(stream);
        return;
      }
      if (!this.ctx) this.ctx = new this.env.AudioContextCtor();
      await this.ctx.resume();
      if (gen !== this.generation) {
        this.stopStream(stream);
        return;
      }
      const line = this.buildLine(role, stream, this.ctx, 1, false);
      this.lines.set(role, line);
      c.phase = 'live-audition';
      c.auditionedDeviceId = c.deviceId;
      this.startMeterLoop();
      this.note('success', `${FALLBACK_LABEL[role]}试听已接通，耳返应有声音。`);
      this.emit();
    } catch (err) {
      if (stream) this.stopStream(stream);
      if (gen !== this.generation) return;
      c.phase = cameFromFault && role === 'primary' ? 'fault' : 'idle';
      this.note(
        'error',
        this.describeMediaError(err, `${FALLBACK_LABEL[role]}试听失败`),
      );
      this.emit();
    }
  }

  /** 停止单路试听（武装/切换中禁止；它只用于试听阶段） */
  stopAudition(role: Role): void {
    if (this.phase === 'running-backup') {
      this.note('warn', '当前输出在备用线路，请使用“停止全部”。');
      this.emit();
      return;
    }
    if (
      this.phase === 'arming' ||
      this.phase === 'armed' ||
      this.phase === 'switching'
    ) {
      this.note('warn', this.phaseBlockReason());
      this.emit();
      return;
    }
    const c = this.channels[role];
    if (!this.lines.has(role)) {
      // 可能正处于 auditioning：仍需作废在途申请，迟到返回的流要被释放
      this.generation++;
      c.phase = 'idle';
      c.active = false;
      this.emit();
      return;
    }
    this.generation++;
    this.releaseLine(role);
    c.phase = 'idle';
    c.active = false;
    this.note('info', `${FALLBACK_LABEL[role]}试听已停止。`);
    this.emit();
  }

  // ---------------------------------------------------------------- 武装

  /**
   * 两路试听都成功后可武装主路：
   * - 递增代次，立即停止备用试听轨道（释放节点）；
   * - 主路保持持续输出并加冕为活动主路。
   * 武装期间禁止另开试听（canAudition 已封死）。
   */
  arm(): void {
    if (this.permission !== 'granted') {
      this.note('error', '请先完成麦克风授权。');
      this.emit();
      return;
    }
    if (this.phase !== 'idle') {
      this.note('warn', this.phaseBlockReason());
      this.emit();
      return;
    }
    if (
      this.channels.primary.phase !== 'live-audition' ||
      this.channels.backup.phase !== 'live-audition'
    ) {
      this.note('error', '主、备两路都须先试听成功，才能武装主路。');
      this.emit();
      return;
    }

    this.generation++;
    const primaryLine = this.lines.get('primary');
    if (primaryLine) primaryLine.activePrimary = true;
    this.channels.primary.active = true;

    this.releaseLine('backup');
    this.channels.backup.phase = 'idle';
    this.channels.backup.active = false;
    this.channels.backup.level = 0;

    this.phase = 'armed';
    this.note(
      'success',
      '主路已武装并持续输出；备用试听已停止，可发起切换。武装期间不能另开试听。',
    );
    this.emit();
  }

  // ---------------------------------------------------------------- 切换

  /**
   * 发起主 -> 备切换：
   * 1. resume 上下文；申请备用候选流（就绪前主路不动，持续输出）；
   * 2. 候选以 gain 0 建链，立即开始 80ms 线性交叉（主 1->0，备 0->1）；
   * 3. 80ms 后停止旧主轨道并断开节点。
   * 任一步失败：候选释放、主路增益恢复并保持输出、回到未武装（须重新试听方可再武装）。
   */
  async switchToBackup(): Promise<void> {
    if (this.phase !== 'armed') {
      this.note('warn', this.phaseBlockReason());
      this.emit();
      return;
    }
    const primaryLine = this.lines.get('primary');
    if (!primaryLine || !primaryLine.activePrimary) {
      this.note('error', '活动主路不可用，请重新试听后再武装。');
      this.enterFault('活动主路已丢失，进入故障态。');
      return;
    }
    const backupDeviceId = this.channels.backup.auditionedDeviceId;
    if (!backupDeviceId) {
      this.note('error', '缺少备用试听记录，请重新试听备用设备。');
      this.emit();
      return;
    }

    const gen = ++this.generation;
    this.phase = 'switching';
    this.channels.backup.phase = 'auditioning';
    this.note('info', '切换开始：保持主路输出，正在接入备用候选…');
    this.emit();

    try {
      if (!this.ctx) throw new Error('音频上下文不可用。');
      if (this.ctx.state !== 'running') {
        await this.ctx.resume();
        if (gen !== this.generation) {
          // 停止或故障已接管：没有需要释放的候选，直接退出
          return;
        }
        // 部分浏览器 resume 可能 resolve 但仍未运行
        if ((this.ctx.state as AudioContextState) !== 'running') {
          throw new Error('音频上下文恢复失败。');
        }
      }

      const md = this.env.mediaDevices;
      if (!md) throw new Error(this.unsupportedReason());
      const stream = await md.getUserMedia({
        audio: { deviceId: { exact: backupDeviceId }, echoCancellation: false },
        video: false,
      });
      if (gen !== this.generation) {
        // 迟到候选：立即释放，绝不接管线路
        this.stopStream(stream);
        return;
      }

      // 备用就绪：候选以 0 增益接入（主路此刻仍在输出）
      const cand = this.buildLine('candidate', stream, this.ctx, 0, false);
      this.lines.set('candidate', cand);
      this.candidate = cand;
      this.channels.backup.phase = 'live-audition';
      this.startMeterLoop();

      const now = this.ctx.currentTime;
      const end = now + CROSSFADE_MS / 1000;
      primaryLine.gain.gain.setValueAtTime(1, now);
      primaryLine.gain.gain.linearRampToValueAtTime(0, end);
      cand.gain.gain.setValueAtTime(0, now);
      cand.gain.gain.linearRampToValueAtTime(1, end);
      this.note('info', '备用就绪，执行 80 毫秒线性交叉…');
      this.emit();

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.crossfadeTimer = null;
          resolve();
        }, CROSSFADE_MS);
        this.crossfadeTimer = timer;

        const tracks = stream.getAudioTracks();
        const onEnded = () => {
          if (this.candidate !== cand) return;
          tracks.forEach((t) => t.removeEventListener('ended', onEnded));
          clearTimeout(timer);
          this.crossfadeTimer = null;
          reject(new Error('候选流在交叉完成前提前结束。'));
        };
        tracks.forEach((t) => t.addEventListener('ended', onEnded, { once: true }));
      });

      if (gen !== this.generation) return; // 交叉期间被停止/故障接管

      // 交叉完成：候选转正为备用活动线路，停止旧主轨道
      this.lines.delete('candidate');
      this.lines.set('backup', cand);
      cand.role = 'backup';
      this.candidate = null;

      this.releaseLine('primary');
      const p = this.channels.primary;
      p.phase = 'idle';
      p.active = false;
      p.level = 0;
      p.auditionedDeviceId = null;

      const b = this.channels.backup;
      b.phase = 'live-audition';
      b.active = true;
      b.auditionedDeviceId = backupDeviceId;
      cand.activePrimary = true;

      this.phase = 'running-backup';
      this.note('success', '交叉完成，已切到备用输出，旧主轨道已停止。');
      this.emit();
    } catch (err) {
      if (gen !== this.generation) {
        // 失败发生在接管之后：候选若已建链也要释放
        this.releaseLine('candidate');
        this.candidate = null;
        return;
      }
      this.abortSwitch(err);
    }
  }

  /**
   * 切换失败回滚：释放候选，主路增益恢复为 1 并继续输出。
   * 回到 idle，两路试听记录作废 —— 重新试听后方可武装。
   */
  private abortSwitch(err: unknown): void {
    // 新的代次作废所有在途 await
    this.generation++;
    if (this.crossfadeTimer) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
    this.releaseLine('candidate');
    this.candidate = null;

    const primaryLine = this.lines.get('primary');
    if (primaryLine && this.ctx) {
      try {
        const now = this.ctx.currentTime;
        primaryLine.gain.gain.cancelScheduledValues(now);
        primaryLine.gain.gain.setValueAtTime(primaryLine.gain.gain.value, now);
        primaryLine.gain.gain.linearRampToValueAtTime(
          1,
          now + CROSSFADE_MS / 1000,
        );
      } catch {
        // 参数自动化不可用时直接置顶，确保主路不被静音
        try {
          primaryLine.gain.gain.value = 1;
        } catch {
          /* 节点可能已关闭 */
        }
      }
    }

    const b = this.channels.backup;
    b.phase = 'idle';
    b.level = 0;
    b.auditionedDeviceId = null;
    const p = this.channels.primary;
    p.auditionedDeviceId = null;

    this.phase = primaryLine ? 'idle' : 'fault';
    this.note(
      'error',
      `切换已取消并保留原主路：${err instanceof Error ? err.message : '未知原因'}。须重新试听后方可武装。`,
    );
    this.emit();
  }

  // ---------------------------------------------------------------- 停止

  /**
   * 释放全部流与节点：停止所有轨道、断开音频图、关闭上下文、取消交叉定时器。
   * 授权结果与设备列表保留；所有通道回到 idle，界面不得残留麦克风占用。
   */
  stopAll(): void {
    this.generation++;
    if (this.crossfadeTimer) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
    this.candidate = null;

    for (const key of ['primary', 'backup', 'candidate'] as const) {
      this.releaseLine(key);
    }

    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;

    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        /* 已关闭则忽略 */
      }
    }
    this.ctx = null;
    this.levelBuf = null;

    for (const role of ['primary', 'backup'] as const) {
      const c = this.channels[role];
      c.phase = 'idle';
      c.active = false;
      c.level = 0;
      c.auditionedDeviceId = null;
    }

    this.phase = this.permission === 'unsupported' ? 'no-support' : 'idle';
    this.note(
      'info',
      '已停止全部线路：所有麦克风轨道与音频节点均已释放。',
    );
    this.emit();
  }

  // ---------------------------------------------------------------- 音频图

  private buildLine(
    role: Role | 'candidate',
    stream: MediaStream,
    ctx: AudioContext,
    initialGain: number,
    activePrimary: boolean,
  ): LiveLine {
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    gain.gain.value = initialGain;
    // analyser 放在增益前，交叉淡出时电平仍反映真实拾音
    source.connect(analyser);
    source.connect(gain);
    gain.connect(ctx.destination);

    const tracks = stream.getAudioTracks();
    const line: LiveLine = {
      role,
      stream,
      tracks,
      ctx,
      source,
      gain,
      analyser,
      activePrimary,
    };
    tracks.forEach((t) =>
      t.addEventListener('ended', () => {
        this.onTrackEnded(line, t);
      }),
    );
    return line;
  }

  private releaseLine(key: Role | 'candidate'): void {
    const line = this.lines.get(key);
    if (!line) return;
    this.lines.delete(key);
    if (this.candidate === line) this.candidate = null;
    try {
      line.source.disconnect();
    } catch {
      /* 节点可能已关闭 */
    }
    try {
      line.gain.disconnect();
    } catch {
      /* ignore */
    }
    try {
      line.analyser.disconnect();
    } catch {
      /* ignore */
    }
    this.stopStream(line.stream);
  }

  private stopStream(stream: MediaStream): void {
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
  }

  // ---------------------------------------------------------------- 电平

  private startMeterLoop(): void {
    if (this.rafId !== null) return;
    const tick = (): void => {
      this.rafId = null;
      if (this.lines.size === 0) {
        this.channels.primary.level = 0;
        this.channels.backup.level = 0;
        return;
      }
      for (const [key, line] of this.lines) {
        const size = line.analyser.fftSize;
        if (!this.levelBuf || this.levelBuf.length !== size) {
          this.levelBuf = new Uint8Array(size);
        }
        line.analyser.getByteTimeDomainData(this.levelBuf);
        // 候选流的电平记到备用通道
        const role: Role | null = key === 'candidate' ? 'backup' : key;
        if (role === 'primary' || role === 'backup') {
          this.channels[role].level = this.rms(this.levelBuf);
        }
      }
      this.emitSoon();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private rms(data: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const r = Math.sqrt(sum / data.length);
    return Math.max(0, Math.min(1, r * 2.2));
  }

  // ---------------------------------------------------------------- 轨道结束

  /**
   * 轨道自行结束（设备拔出/系统回收）：
   * - 活动主路（武装后主、或切换后的备）结束 -> 故障态，释放一切；
   * - 切换中候选提前结束 -> 走取消流程保留主路；
   * - 普通试听结束 -> 仅释放该路。
   */
  private onTrackEnded(line: LiveLine, _track: MediaStreamTrack): void {
    // 已被显式释放的线路（其 stop 不应触发 ended，这里仅作防御）直接忽略
    const stillOwned =
      this.lines.has(line.role) || this.candidate === line;
    if (!stillOwned) return;
    if (line === this.candidate && this.phase === 'switching') {
      this.abortSwitch(new Error('候选流提前结束。'));
      return;
    }
    if (line.activePrimary) {
      this.enterFault(
        line.role === 'backup'
          ? '活动备用线路已结束，进入故障态。'
          : '活动主路意外结束，进入故障态。',
      );
      return;
    }
    const key = line.role;
    if (key === 'primary' || key === 'backup') {
      this.releaseLine(key);
      const c = this.channels[key];
      if (this.phase !== 'fault') c.phase = 'idle';
      c.active = false;
      c.level = 0;
      c.auditionedDeviceId = null;
      this.note(
        'warn',
        `${FALLBACK_LABEL[key]}试听轨道已结束，须重新试听后才能武装。`,
      );
      this.emit();
    }
  }

  private enterFault(reason: string): void {
    this.generation++;
    if (this.crossfadeTimer) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
    // 故障时释放全部流和节点（含切换中可能已建链的迟到候选）
    for (const key of ['primary', 'backup', 'candidate'] as const) {
      this.releaseLine(key);
    }
    this.candidate = null;
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
    this.levelBuf = null;

    for (const role of ['primary', 'backup'] as const) {
      const c = this.channels[role];
      c.phase = 'fault';
      c.active = false;
      c.level = 0;
      c.auditionedDeviceId = null;
    }
    this.phase = 'fault';
    this.note('error', `${reason}全部线路已释放，重新试听后方可武装。`);
    this.emit();
  }

  // ---------------------------------------------------------------- 工具

  private ensureReady(): string | null {
    if (!this.env.mediaDevices) return this.unsupportedReason();
    if (!this.env.AudioContextCtor)
      return '当前浏览器不支持 Web Audio API（AudioContext 不可用），无法建立耳返。';
    if (!this.env.isSecureContext)
      return '非安全上下文（需 HTTPS 或 localhost），浏览器禁止麦克风访问。';
    if (this.permission === 'denied')
      return '麦克风权限已被拒绝，请在浏览器站点设置中允许后重试。';
    if (this.permission !== 'granted') return '请先授权麦克风。';
    return null;
  }

  private unsupportedReason(): string {
    if (!this.env.mediaDevices)
      return '当前浏览器缺少 MediaDevices 接口（navigator.mediaDevices 不可用），无法使用麦克风。';
    if (!this.env.AudioContextCtor)
      return '当前浏览器不支持 Web Audio API（AudioContext 不可用）。';
    return '浏览器能力不足。';
  }

  private phaseBlockReason(): string {
    switch (this.phase) {
      case 'arming':
      case 'armed':
        return '主路武装期间禁止另开试听；可发起切换或先停止。';
      case 'switching':
        return '切换进行中，请等待结果。';
      case 'running-backup':
        return '当前输出在备用线路，请先停止全部线路再重新试听。';
      case 'fault':
        return '故障态：请先重新试听主、备两路。';
      default:
        return '当前阶段不允许该操作。';
    }
  }

  private describeMediaError(err: unknown, prefix: string): string {
    const name = err instanceof DOMException ? err.name : '';
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return `${prefix}：用户拒绝了麦克风权限。`;
      case 'NotFoundError':
      case 'OverconstrainedError':
        return `${prefix}：指定的麦克风设备不存在或已拔出。`;
      case 'NotReadableError':
      case 'TrackStartError':
        return `${prefix}：麦克风被其他程序占用或硬件不可读。`;
      case 'AbortError':
        return `${prefix}：浏览器中止了设备访问。`;
      default:
        return `${prefix}：${err instanceof Error ? err.message : '未知错误'}。`;
    }
  }
}
