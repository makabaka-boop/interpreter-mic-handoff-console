/**
 * 可控媒体替身：只在 Vitest 中使用，模拟浏览器
 * MediaDevices / AudioContext / requestAnimationFrame，
 * 用于核对流与节点的释放、代次接管等规则。生产代码不引用本文件。
 */

export interface FakeTrackOptions {
  deviceId?: string;
}

export class FakeMediaStreamTrack {
  readonly kind = 'audio';
  readonly id: string;
  readonly label: string;
  readonly deviceId: string;
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  stopCount = 0;
  private listeners = new Set<(e: { type: 'ended' }) => void>();

  constructor(label: string, opts: FakeTrackOptions = {}) {
    this.id = `track-${Math.random().toString(36).slice(2, 9)}`;
    this.label = label;
    this.deviceId = opts.deviceId ?? label;
  }

  stop(): void {
    this.stopCount++;
    // 与浏览器一致：调用 stop() 只改 readyState，不派发 ended。
    this.readyState = 'ended';
  }

  /** 模拟设备拔出 / 系统回收导致的提前结束（未经 stop） */
  simulateEnded(): void {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    for (const fn of this.listeners) fn({ type: 'ended' });
  }

  addEventListener(type: string, fn: (e: { type: 'ended' }) => void): void {
    if (type === 'ended') this.listeners.add(fn);
  }

  removeEventListener(
    type: string,
    fn: (e: { type: 'ended' }) => void,
  ): void {
    if (type === 'ended') this.listeners.delete(fn);
  }

  dispatchEvent(): boolean {
    return true;
  }

  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId };
  }

  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }
}

export class FakeMediaStream {
  private tracks: FakeMediaStreamTrack[];
  readonly id: string;
  active = true;

  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.tracks = [...tracks];
    this.id = `stream-${Math.random().toString(36).slice(2, 9)}`;
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return [...this.tracks];
  }

  getTracks(): FakeMediaStreamTrack[] {
    return [...this.tracks];
  }

  addTrack(t: FakeMediaStreamTrack): void {
    this.tracks.push(t);
  }

  removeTrack(t: FakeMediaStreamTrack): void {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

export interface FakeDevice {
  deviceId: string;
  label: string;
}

interface PendingRequest {
  resolve: (s: FakeMediaStream) => void;
  reject: (e: unknown) => void;
  constraints: MediaStreamConstraints;
  deviceId: string | null;
}

export class FakeMediaDevices {
  devices: FakeDevice[];
  pending: PendingRequest[] = [];
  private listeners = new Set<() => void>();

  /** 动态行为开关，测试可直接改写 */
  rejectName: string | null = null;
  rejectOnce: string | null = null;
  failEnumerate = false;
  requestCount = 0;
  streams: FakeMediaStream[] = [];

  constructor(devices: FakeDevice[]) {
    this.devices = devices;
  }

  addEventListener(type: string, fn: () => void): void {
    if (type === 'devicechange') this.listeners.add(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    if (type === 'devicechange') this.listeners.delete(fn);
  }

  simulateDeviceChange(devices: FakeDevice[]): void {
    this.devices = devices;
    for (const fn of this.listeners) fn();
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    if (this.failEnumerate) throw new DOMException('boom', 'NotReadableError');
    return this.devices.map(
      (d) =>
        ({
          deviceId: d.deviceId,
          kind: 'audioinput',
          label: d.label,
          groupId: 'g1',
          toJSON() {
            return this;
          },
        }) as unknown as MediaDeviceInfo,
    );
  }

  getUserMedia(
    constraints: MediaStreamConstraints,
  ): Promise<FakeMediaStream> {
    this.requestCount++;
    const audio = constraints.audio as
      | MediaTrackConstraints
      | boolean
      | undefined;
    let deviceId: string | null = null;
    if (audio && typeof audio === 'object' && audio.deviceId) {
      const raw = audio.deviceId as string | ConstrainDOMStringParameters;
      deviceId = typeof raw === 'string' ? raw : (raw.exact as string);
    }

    const fail = this.rejectOnce ?? this.rejectName;
    if (this.rejectOnce) this.rejectOnce = null;
    if (fail) {
      return Promise.reject(new DOMException('fake failure', fail));
    }

    return new Promise<FakeMediaStream>((resolve, reject) => {
      const req: PendingRequest = {
        resolve: (s) => {
          this.streams.push(s);
          resolve(s);
        },
        reject,
        constraints,
        deviceId,
      };
      this.pending.push(req);
    });
  }

  /** 放行最早一个挂起申请，返回生成的流和轨道 */
  resolvePending(): {
    stream: FakeMediaStream;
    track: FakeMediaStreamTrack;
  } {
    const req = this.pending.shift();
    if (!req) throw new Error('没有挂起的 getUserMedia 请求');
    const id =
      req.deviceId ?? this.devices[0]?.deviceId ?? 'unknown-device';
    const device = this.devices.find((d) => d.deviceId === id);
    const track = new FakeMediaStreamTrack(device?.label ?? id, {
      deviceId: id,
    });
    const stream = new FakeMediaStream([track]);
    req.resolve(stream);
    return { stream, track };
  }

  rejectPending(name = 'NotAllowedError'): void {
    const req = this.pending.shift();
    if (!req) throw new Error('没有挂起的 getUserMedia 请求');
    req.reject(new DOMException('fake failure', name));
  }
}

// ---------------------------------------------------------------- Web Audio

interface RampEvent {
  at: number;
  value: number;
}

export class FakeAudioParam {
  value: number;
  events: { type: string; at: number; value?: number }[] = [];

  constructor(initial: number) {
    this.value = initial;
  }

  setValueAtTime(value: number, at: number): void {
    this.value = value;
    this.events.push({ type: 'setValueAtTime', at, value });
  }

  linearRampToValueAtTime(value: number, at: number): RampEvent {
    this.events.push({ type: 'linearRamp', at, value });
    return { at, value };
  }

  cancelScheduledValues(at: number): void {
    this.events = this.events.filter((e) => e.at < at);
    this.events.push({ type: 'cancel', at });
  }
}

export class FakeNode {
  connectedTo: FakeNode[] = [];
  disconnected = false;

  connect(node: FakeNode): FakeNode {
    this.connectedTo.push(node);
    return node;
  }

  disconnect(): void {
    this.disconnected = true;
    this.connectedTo = [];
  }
}

export class FakeMediaStreamSourceNode extends FakeNode {}

export class FakeGainNode extends FakeNode {
  gain: FakeAudioParam;

  constructor(initial: number) {
    super();
    this.gain = new FakeAudioParam(initial);
  }
}

export interface FillFn {
  (data: Uint8Array): void;
}

export class FakeAnalyserNode extends FakeNode {
  fftSize = 256;
  fill: FillFn | null = null;
  getByteTimeDomainDataCalls = 0;

  getByteTimeDomainData(data: Uint8Array): void {
    this.getByteTimeDomainDataCalls++;
    if (this.fill) this.fill(data);
    else data.fill(128);
  }
}

export class FakeAudioDestinationNode extends FakeNode {}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 1.0;
  destination = new FakeAudioDestinationNode();
  resumeCalls = 0;
  resumeFail = false;
  closed = false;
  created: {
    sources: FakeMediaStreamSourceNode[];
    gains: FakeGainNode[];
    analysers: FakeAnalyserNode[];
  } = { sources: [], gains: [], analysers: [] };

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeFail) {
      this.state = 'suspended';
      throw new DOMException('resume failed', 'InvalidStateError');
    }
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
  }

  createMediaStreamSource(): FakeMediaStreamSourceNode {
    const n = new FakeMediaStreamSourceNode();
    this.created.sources.push(n);
    return n;
  }

  createGain(): FakeGainNode {
    const n = new FakeGainNode(1);
    this.created.gains.push(n);
    return n;
  }

  createAnalyser(): FakeAnalyserNode {
    const n = new FakeAnalyserNode();
    this.created.analysers.push(n);
    return n;
  }

  get lastGain(): FakeGainNode {
    const g = this.created.gains[this.created.gains.length - 1];
    if (!g) throw new Error('尚未创建 GainNode');
    return g;
  }
}

// ---------------------------------------------------------------- rAF

export interface FakeRaf {
  request: typeof requestAnimationFrame;
  cancel: typeof cancelAnimationFrame;
  runFrame: () => void;
  pending: () => number;
}

/**
 * 手动驱动的 requestAnimationFrame：
 * 引擎调度后不会自动执行，测试调用 runFrame() 精确控制电平帧。
 */
export function installFakeRaf(): FakeRaf {
  const handlers = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const request: typeof requestAnimationFrame = ((
    cb: FrameRequestCallback,
  ) => {
    const id = nextId++;
    handlers.set(id, cb);
    return id as unknown as number;
  }) as typeof requestAnimationFrame;
  const cancel: typeof cancelAnimationFrame = ((id: number) => {
    handlers.delete(id);
  }) as typeof cancelAnimationFrame;

  return {
    request,
    cancel,
    runFrame: () => {
      const entries = [...handlers.entries()];
      handlers.clear();
      for (const [id, cb] of entries) {
        void id;
        cb(performance.now());
      }
    },
    pending: () => handlers.size,
  };
}

export function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
