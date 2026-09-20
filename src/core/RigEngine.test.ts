import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RigEngine, CROSSFADE_MS } from '../core/RigEngine';
import type { RigEnv } from '../core/types';
import {
  FakeAudioContext,
  FakeMediaDevices,
  FakeMediaStream,
  FakeMediaStreamTrack,
  installFakeRaf,
  nextMicrotask,
  type FakeMediaStreamTrack as TTrack,
  type FakeRaf,
} from '../test/fakes';

const DEV_PRIMARY = 'mic-primary';
const DEV_BACKUP = 'mic-backup';

interface Harness {
  engine: RigEngine;
  md: FakeMediaDevices;
  raf: FakeRaf;
}

function makeEngine(
  overrides: {
    mediaDevices?: FakeMediaDevices | null;
    AudioContextCtor?: typeof FakeAudioContext | null;
    isSecureContext?: boolean;
  } = {},
): Harness {
  const md =
    overrides.mediaDevices === undefined
      ? new FakeMediaDevices([
          { deviceId: DEV_PRIMARY, label: 'Fake Primary Mic' },
          { deviceId: DEV_BACKUP, label: 'Fake Backup Mic' },
        ])
      : overrides.mediaDevices;
  const raf = installFakeRaf();
  (globalThis as { requestAnimationFrame: unknown }).requestAnimationFrame =
    raf.request;
  (globalThis as { cancelAnimationFrame: unknown }).cancelAnimationFrame =
    raf.cancel;

  const env: Partial<RigEnv> = {
    mediaDevices: md as unknown as MediaDevices,
    AudioContextCtor:
      overrides.AudioContextCtor === undefined
        ? (FakeAudioContext as unknown as typeof AudioContext)
        : (overrides.AudioContextCtor as unknown as typeof AudioContext),
    isSecureContext:
      overrides.isSecureContext === undefined
        ? true
        : overrides.isSecureContext,
  };
  return { engine: new RigEngine(env), md: md as FakeMediaDevices, raf };
}

async function grantPermission(h: Harness): Promise<void> {
  void h.engine.requestPermission();
  await nextMicrotask();
  h.md.resolvePending();
  await nextMicrotask();
  await nextMicrotask();
}

async function startAudition(
  h: Harness,
  role: 'primary' | 'backup',
  deviceId: string,
): Promise<{ track: TTrack }> {
  h.engine.selectDevice(role, deviceId);
  void h.engine.audition(role);
  await nextMicrotask();
  const { track } = h.md.resolvePending();
  await nextMicrotask();
  await nextMicrotask();
  return { track };
}

async function armBoth(h: Harness): Promise<{
  primary: TTrack;
  backup: TTrack;
}> {
  const p = await startAudition(h, 'primary', DEV_PRIMARY);
  const b = await startAudition(h, 'backup', DEV_BACKUP);
  h.engine.arm();
  return { primary: p.track, backup: b.track };
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('授权与能力检测', () => {
  it('授权成功后枚举设备，探针流必须停止', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const snap = h.engine.getSnapshot();
    expect(snap.permission).toBe('granted');
    expect(snap.devices).toHaveLength(2);
    // 授权探针是第一个流
    const probeTrack = h.md.streams[0].getAudioTracks()[0];
    expect(probeTrack.stopCount).toBe(1);
    expect(h.engine.getSnapshot().can.requestPermission).toBe(false);
  });

  it('拒绝授权时给出原因且不进入已授权', async () => {
    const h = makeEngine();
    const p = h.engine.requestPermission();
    await nextMicrotask();
    h.md.rejectPending('NotAllowedError');
    await p;
    const snap = h.engine.getSnapshot();
    expect(snap.permission).toBe('denied');
    expect(snap.messages.at(-1)?.text).toContain('拒绝');
    expect(snap.can.auditionPrimary).toBe(false);
  });

  it('缺少 MediaDevices 时直接进入不支持态并说明原因', () => {
    const h = makeEngine({ mediaDevices: null });
    const snap = h.engine.getSnapshot();
    expect(snap.phase).toBe('no-support');
    expect(snap.permission).toBe('unsupported');
    expect(snap.messages.at(-1)?.text).toContain('MediaDevices');
    expect(snap.can.requestPermission).toBe(false);
  });

  it('缺少 AudioContext 时试听被拒绝', async () => {
    const h = makeEngine({ AudioContextCtor: null });
    await grantPermission(h);
    h.engine.selectDevice('primary', DEV_PRIMARY);
    await h.engine.audition('primary');
    expect(h.engine.getSnapshot().messages.at(-1)?.text).toContain(
      'Web Audio',
    );
  });

  it('非安全上下文给出原因', async () => {
    const h = makeEngine({ isSecureContext: false });
    await grantPermission(h);
    h.engine.selectDevice('primary', DEV_PRIMARY);
    await h.engine.audition('primary');
    expect(h.engine.getSnapshot().messages.at(-1)?.text).toContain(
      '安全上下文',
    );
  });
});

describe('试听与资源释放', () => {
  it('试听接通音频图：source->gain/destination，实时电平可更新', async () => {
    const h = makeEngine();
    await grantPermission(h);
    await startAudition(h, 'primary', DEV_PRIMARY);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx).toBeTruthy();
    expect(ctx.created.sources).toHaveLength(1);
    expect(ctx.created.gains).toHaveLength(1);
    const source = ctx.created.sources[0];
    // analyser 与 gain 都应与 source 相连，gain 连到 destination
    expect(source.connectedTo.length).toBe(2);
    expect(ctx.created.gains[0].connectedTo).toContain(ctx.destination);

    // 注入非静音数据，驱动一帧 rAF
    ctx.created.analysers[0].fill = (data: Uint8Array) => {
      for (let i = 0; i < data.length; i++) data[i] = 128 + 40;
    };
    h.raf.runFrame();
    await nextMicrotask();
    expect(h.engine.getSnapshot().primary.level).toBeGreaterThan(0);
  });

  it('停止试听停止轨道并断开节点', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const { track } = await startAudition(h, 'primary', DEV_PRIMARY);
    const ctx = FakeAudioContext.instances[0];
    const source = ctx.created.sources[0];
    const gain = ctx.created.gains[0];

    h.engine.stopAudition('primary');
    expect(track.stopCount).toBe(1);
    expect(source.disconnected).toBe(true);
    expect(gain.disconnected).toBe(true);
    expect(h.engine.getSnapshot().primary.phase).toBe('idle');
    expect(h.engine.getSnapshot().micInUse).toBe(false);
  });

  it('设备不存在（OverconstrainedError）时报错，已有其他线路不受影响', async () => {
    const h = makeEngine();
    await grantPermission(h);
    await startAudition(h, 'primary', DEV_PRIMARY);

    h.engine.selectDevice('backup', DEV_BACKUP);
    h.md.rejectOnce = 'OverconstrainedError';
    void h.engine.audition('backup');
    await nextMicrotask();
    // rejectOnce 在 getUserMedia 入口直接同步 reject
    await nextMicrotask();
    await nextMicrotask();

    const snap = h.engine.getSnapshot();
    expect(snap.messages.at(-1)?.text).toContain('设备不存在');
    // 主路仍在工作
    expect(snap.primary.phase).toBe('live-audition');
    expect(snap.micInUse).toBe(true);
  });

  it('设备列表里消失的设备不允许试听', async () => {
    const h = makeEngine();
    await grantPermission(h);
    h.engine.selectDevice('primary', DEV_PRIMARY);
    h.md.simulateDeviceChange([{ deviceId: DEV_BACKUP, label: 'only-backup' }]);
    await nextMicrotask();
    await h.engine.audition('primary');
    expect(h.engine.getSnapshot().messages.at(-1)?.text).toContain('不存在');
    expect(h.md.pending).toHaveLength(0);
  });
});

describe('代次接管', () => {
  it('快速连续试听：较早返回的流立即停止，且不得改写提示', async () => {
    const h = makeEngine();
    await grantPermission(h);
    h.engine.selectDevice('primary', DEV_PRIMARY);

    // 第一次试听，挂起
    void h.engine.audition('primary');
    await nextMicrotask();
    expect(h.md.pending).toHaveLength(1);

    // 记录第一条提示（第一次“正在打开主输入试听”之后的）
    // 第二次试听，递增代次
    void h.engine.audition('primary');
    await nextMicrotask();
    expect(h.md.pending).toHaveLength(2);

    // 较早的流先返回：必须立即停止，不建链、不改写提示
    const older = h.md.resolvePending();
    await nextMicrotask();
    await nextMicrotask();
    expect(older.track.stopCount).toBe(1);
    expect(h.engine.getSnapshot().primary.phase).toBe('auditioning');
    expect(h.engine.getSnapshot().messages.at(-1)?.text).toContain('正在打开');

    // 最新代次返回：接管
    const newer = h.md.resolvePending();
    await nextMicrotask();
    await nextMicrotask();
    expect(newer.track.stopCount).toBe(0);
    expect(h.engine.getSnapshot().primary.phase).toBe('live-audition');
    expect(h.engine.getSnapshot().messages.at(-1)?.text).toContain('接通');
  });

  it('试听返回后用户已点停止：流被释放，状态保持 idle', async () => {
    const h = makeEngine();
    await grantPermission(h);
    h.engine.selectDevice('primary', DEV_PRIMARY);
    void h.engine.audition('primary');
    await nextMicrotask();

    h.engine.stopAudition('primary'); // 代次 +1，状态 idle
    const late = h.md.resolvePending();
    await nextMicrotask();
    await nextMicrotask();
    expect(late.track.stopCount).toBe(1);
    const snap = h.engine.getSnapshot();
    expect(snap.primary.phase).toBe('idle');
    expect(snap.micInUse).toBe(false);
  });
});

describe('武装', () => {
  it('武装：停止备用试听轨道与节点，主路保持输出', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const { primary, backup } = await armBoth(h);
    const snap = h.engine.getSnapshot();
    expect(snap.phase).toBe('armed');
    expect(backup.stopCount).toBe(1);
    expect(primary.stopCount).toBe(0);
    expect(snap.primary.active).toBe(true);
    expect(snap.primary.phase).toBe('live-audition');
    expect(snap.backup.phase).toBe('idle');
  });

  it('武装期间禁止另开试听和更改设备', async () => {
    const h = makeEngine();
    await grantPermission(h);
    await armBoth(h);
    expect(h.engine.getSnapshot().can.auditionPrimary).toBe(false);
    expect(h.engine.getSnapshot().can.auditionBackup).toBe(false);

    await h.engine.audition('backup');
    expect(h.md.pending).toHaveLength(0);
    expect(h.engine.getSnapshot().messages.at(-1)?.text).toContain('武装');

    h.engine.selectDevice('backup', DEV_PRIMARY);
    expect(h.engine.getSnapshot().backup.deviceId).toBe(DEV_BACKUP);
  });

  it('只有一路试听成功时不能武装', async () => {
    const h = makeEngine();
    await grantPermission(h);
    await startAudition(h, 'primary', DEV_PRIMARY);
    h.engine.arm();
    expect(h.engine.getSnapshot().phase).toBe('idle');
    expect(h.engine.getSnapshot().can.arm).toBe(false);
  });
});

describe('切换', () => {
  it('完整切换：主路持续输出 -> 80ms 线性交叉 -> 停旧主轨 -> 备用活动', async () => {
    vi.useFakeTimers();
    const h = makeEngine();
    await grantPermission(h);
    const { primary } = await armBoth(h);

    void h.engine.switchToBackup();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.md.pending).toHaveLength(1);
    // 候选就绪前主路仍在
    expect(primary.stopCount).toBe(0);

    const candidate = h.md.resolvePending();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const ctx = FakeAudioContext.instances[0];
    const candidateGain = ctx.lastGain;
    // 候选增益从 0 线性到 1；主路 1 -> 0，时长 80ms
    const ramp = candidateGain.gain.events.find(
      (e: { type: string; value?: number }) => e.type === 'linearRamp',
    );
    expect(ramp?.value).toBe(1);
    expect(ramp?.at).toBeCloseTo(1 + CROSSFADE_MS / 1000, 5);

    // 交叉完成前旧主轨不能停
    await vi.advanceTimersByTimeAsync(CROSSFADE_MS - 10);
    expect(primary.stopCount).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(0);

    const snap = h.engine.getSnapshot();
    expect(primary.stopCount).toBe(1);
    expect(candidate.track.stopCount).toBe(0);
    expect(snap.phase).toBe('running-backup');
    expect(snap.backup.active).toBe(true);
    expect(snap.primary.phase).toBe('idle');
  });

  it('候选被拒绝：主路保留并恢复增益，需重新试听才能再武装', async () => {
    vi.useFakeTimers();
    const h = makeEngine();
    await grantPermission(h);
    const { primary } = await armBoth(h);
    const ctx = FakeAudioContext.instances[0];
    // 主路 gain 在其试听时创建，是该上下文上的第一个 gain
    const primaryGain = ctx.created.gains[0];

    const p = h.engine.switchToBackup();
    await vi.advanceTimersByTimeAsync(0);
    h.md.rejectPending('NotAllowedError');
    await p;
    await vi.advanceTimersByTimeAsync(0);

    const snap = h.engine.getSnapshot();
    expect(primary.stopCount).toBe(0);
    expect(snap.phase).toBe('idle');
    expect(snap.primary.phase).toBe('live-audition');
    // 主路增益被安排回到 1
    const restoreRamp = primaryGain.gain.events
      .filter((e: { type: string }) => e.type === 'linearRamp')
      .at(-1);
    expect(restoreRamp?.value).toBe(1);
    expect(snap.can.arm).toBe(false);
    expect(snap.messages.at(-1)?.text).toContain('保留原主路');
  });

  it('候选在交叉期间提前结束：回滚保留主路并释放候选', async () => {
    vi.useFakeTimers();
    const h = makeEngine();
    await grantPermission(h);
    const { primary } = await armBoth(h);

    void h.engine.switchToBackup();
    await vi.advanceTimersByTimeAsync(0);
    const { track: candidate } = h.md.resolvePending();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    candidate.simulateEnded();
    await vi.advanceTimersByTimeAsync(0);

    expect(candidate.stopCount).toBe(1);
    expect(primary.stopCount).toBe(0);
    const snap = h.engine.getSnapshot();
    expect(snap.phase).toBe('idle');
    expect(snap.backup.phase).toBe('idle');
  });

  it('AudioContext.resume 失败：保留原主路，不申请候选', async () => {
    vi.useFakeTimers();
    const h = makeEngine();
    await grantPermission(h);
    const { primary } = await armBoth(h);
    const ctx = FakeAudioContext.instances[0];
    ctx.state = 'suspended';
    ctx.resumeFail = true;

    await h.engine.switchToBackup();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.md.pending).toHaveLength(0);
    expect(primary.stopCount).toBe(0);
    const snap = h.engine.getSnapshot();
    expect(snap.phase).toBe('idle');
    expect(snap.messages.at(-1)?.text).toContain('保留原主路');
  });

  it('切换中点击停止：迟到的候选流立即释放，不接管线路', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const { primary } = await armBoth(h);
    void h.engine.switchToBackup();
    await nextMicrotask();
    expect(h.md.pending).toHaveLength(1);

    h.engine.stopAll();
    expect(primary.stopCount).toBe(1);

    const late = h.md.resolvePending();
    await nextMicrotask();
    await nextMicrotask();
    expect(late.track.stopCount).toBe(1);
    const snap = h.engine.getSnapshot();
    expect(snap.phase).toBe('idle');
    expect(snap.backup.phase).toBe('idle');
    expect(snap.micInUse).toBe(false);
    expect(snap.messages.at(-1)?.kind).not.toBe('success');
  });
});

describe('故障态', () => {
  it('活动主路一旦结束即进入故障态并释放全部线路', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const { primary } = await armBoth(h);
    primary.simulateEnded();
    await nextMicrotask();

    const snap = h.engine.getSnapshot();
    expect(snap.phase).toBe('fault');
    expect(snap.primary.phase).toBe('fault');
    expect(snap.micInUse).toBe(false);
    expect(snap.messages.at(-1)?.text).toContain('故障');
    expect(snap.can.arm).toBe(false);
  });

  it('切换为备用后活动备用结束同样进入故障态', async () => {
    vi.useFakeTimers();
    const h = makeEngine();
    await grantPermission(h);
    await armBoth(h);

    void h.engine.switchToBackup();
    await vi.advanceTimersByTimeAsync(0);
    const { track: candidate } = h.md.resolvePending();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CROSSFADE_MS + 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.getSnapshot().phase).toBe('running-backup');

    candidate.simulateEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.getSnapshot().phase).toBe('fault');
  });

  it('故障后重新试听即可退出故障态，两路重新试听后才能武装', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const { primary } = await armBoth(h);
    primary.simulateEnded();
    expect(h.engine.getSnapshot().phase).toBe('fault');

    await startAudition(h, 'primary', DEV_PRIMARY);
    expect(h.engine.getSnapshot().phase).toBe('idle');
    expect(h.engine.getSnapshot().can.arm).toBe(false);

    await startAudition(h, 'backup', DEV_BACKUP);
    expect(h.engine.getSnapshot().can.arm).toBe(true);
  });

  it('普通试听轨道提前结束只释放该路，不进故障态', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const { track: p } = await startAudition(h, 'primary', DEV_PRIMARY);
    await startAudition(h, 'backup', DEV_BACKUP);
    p.simulateEnded();
    await nextMicrotask();
    const snap = h.engine.getSnapshot();
    expect(snap.phase).toBe('idle');
    expect(snap.primary.phase).toBe('idle');
    expect(snap.backup.phase).toBe('live-audition');
  });
});

describe('停止全部', () => {
  it('释放全部流和节点、关闭上下文、无麦克风残留、rAF 不再调度', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const p = await startAudition(h, 'primary', DEV_PRIMARY);
    const b = await startAudition(h, 'backup', DEV_BACKUP);
    const ctx = FakeAudioContext.instances[0];

    h.raf.runFrame(); // 让电平循环开始续帧
    await nextMicrotask();
    expect(h.raf.pending()).toBe(1);

    h.engine.stopAll();
    expect(p.track.stopCount).toBe(1);
    expect(b.track.stopCount).toBe(1);
    expect(ctx.closed).toBe(true);
    expect(h.raf.pending()).toBe(0);

    const snap = h.engine.getSnapshot();
    expect(snap.micInUse).toBe(false);
    expect(snap.primary.phase).toBe('idle');
    expect(snap.backup.phase).toBe('idle');
    expect(snap.permission).toBe('granted'); // 授权保留
    expect(snap.devices).toHaveLength(2); // 设备列表保留
  });

  it('停止后再次试听可正常工作（上下文重建）', async () => {
    const h = makeEngine();
    await grantPermission(h);
    await startAudition(h, 'primary', DEV_PRIMARY);
    h.engine.stopAll();
    await startAudition(h, 'backup', DEV_BACKUP);
    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(h.engine.getSnapshot().backup.phase).toBe('live-audition');
  });
});

describe('代次不覆盖提示', () => {
  it('重复授权时较早返回的授权结果不回写状态，探针立即停止', async () => {
    const h = makeEngine();
    void h.engine.requestPermission();
    await nextMicrotask();
    void h.engine.requestPermission();
    await nextMicrotask();
    expect(h.md.pending).toHaveLength(2);

    // 较早代次的授权先成功（手动从队列移除并放行）
    const older = h.md.pending.shift()!;
    const staleTrack = new FakeMediaStreamTrack('probe-old');
    const staleStream = new FakeMediaStream([staleTrack]);
    older.resolve(staleStream);
    await nextMicrotask();
    expect(staleTrack.stopCount).toBe(1);
    const mid = h.engine.getSnapshot();
    expect(mid.permission).toBe('prompting');

    // 最新代次成功后才落状态
    h.md.resolvePending();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.engine.getSnapshot().permission).toBe('granted');
  });

  it('切换期间活动主路结束即故障，随后迟到的候选也被释放', async () => {
    const h = makeEngine();
    await grantPermission(h);
    const { primary } = await armBoth(h);

    void h.engine.switchToBackup();
    await nextMicrotask();
    expect(h.md.pending).toHaveLength(1);

    primary.simulateEnded();
    await nextMicrotask();
    expect(h.engine.getSnapshot().phase).toBe('fault');

    const late = h.md.resolvePending();
    await nextMicrotask();
    await nextMicrotask();
    expect(late.track.stopCount).toBe(1);
    const snap = h.engine.getSnapshot();
    expect(snap.phase).toBe('fault');
    expect(snap.micInUse).toBe(false);
  });
});
