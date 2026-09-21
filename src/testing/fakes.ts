import type {
  AudioContextLike,
  AudioNodeLike,
  GainNodeLike,
  Host,
  MediaDeviceInfoLike,
  MediaStreamConstraintsLike,
  MediaStreamLike,
  MediaStreamTrackLike,
} from '../domain/types'
import type { Scheduler } from '../domain/SwitchbenchEngine'

/**
 * 可控媒体替身（仅用于 Vitest 与引擎装配）。
 * 生产代码从不引用本文件：真实页面走 BrowserHost + 浏览器原生设备。
 *
 * 设计要点：
 *  - 每条轨道的 ended 事件、readyState、stop() 都可在测试中直接操纵；
 *  - getUserMedia 支持 grant / reject / pending 三态与按 deviceId 拒绝；
 *  - 图节点记录 disconnect 次数，用来核对“节点断开、轨道释放”。
 */

type Listener = (event?: unknown) => void

export class FakeTrack implements MediaStreamTrackLike {
  kind = 'audio'
  readyState: 'live' | 'ended' = 'live'
  label: string
  deviceId: string
  stopCount = 0
  private listeners = new Map<string, Set<Listener>>()

  constructor(label: string, deviceId: string) {
    this.label = label
    this.deviceId = deviceId
  }

  stop(): void {
    this.stopCount++
    if (this.readyState === 'live') {
      this.readyState = 'ended'
      this.emit('ended')
    }
  }

  /** 模拟设备自然掉线（未调用 stop）。 */
  endNaturally(): void {
    if (this.readyState === 'live') {
      this.readyState = 'ended'
      this.emit('ended')
    }
  }

  getSettings(): { deviceId: string } {
    return { deviceId: this.deviceId }
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  private emit(type: string): void {
    this.listeners.get(type)?.forEach((fn) => fn({ type }))
  }
}

export class FakeStream implements MediaStreamLike {
  constructor(public tracks: FakeTrack[]) {}

  getTracks(): FakeTrack[] {
    return this.tracks
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
}

export interface RequestRecord {
  deviceId: string
  resolve: (stream: MediaStreamLike) => void
  reject: (error: Error) => void
}

export class FakeMediaDevices {
  grantedLabels = true
  private pending: RequestRecord[] = []
  requests: RequestRecord[] = []

  constructor(public devices: MediaDeviceInfoLike[]) {}

  getUserMedia(constraints: MediaStreamConstraintsLike): Promise<MediaStreamLike> {
    const audio = constraints.audio as
      | boolean
      | { deviceId?: { exact: string } }
      | undefined
    const deviceId =
      audio && typeof audio === 'object' && audio.deviceId
        ? audio.deviceId.exact
        : ''
    return new Promise<MediaStreamLike>((resolve, reject) => {
      const record: RequestRecord = {
        deviceId: deviceId ?? '',
        resolve,
        reject: (error) => reject(attachName(error)),
      }
      this.pending.push(record)
      this.requests.push(record)
    })
  }

  async enumerateDevices(): Promise<MediaDeviceInfoLike[]> {
    return this.devices.map((d) => ({ ...d }))
  }

  pendingCount(): number {
    return this.pending.length
  }

  /** 允许测试按取流顺序解析请求。 */
  grantNext(labelPrefix = 'Fake Mic'): FakeStream {
    const record = this.pending.shift()
    if (!record) throw new Error('没有待决的 getUserMedia 请求')
    let device: MediaDeviceInfoLike | undefined
    if (record.deviceId) {
      device = this.devices.find((d) => d.deviceId === record.deviceId)
    } else {
      // 无 deviceId 约束（授权探测）：返回第一台。
      device = this.devices[0]
    }
    if (!device) {
      throw new Error(`设备不存在：${record.deviceId}`)
    }
    const track = new FakeTrack(`${labelPrefix} ${device.label}`, device.deviceId)
    const stream = new FakeStream([track])
    record.resolve(stream)
    return stream
  }

  rejectNext(name = 'NotAllowedError'): void {
    const record = this.pending.shift()
    if (!record) throw new Error('没有待决的 getUserMedia 请求')
    const err = new Error(`fake ${name}`)
    ;(err as Error & { name: string }).name = name
    record.reject(err)
  }

  /** 不自动处理，由测试自行决定时机（模拟提前结束等）。 */
  peekPending(): RequestRecord[] {
    return [...this.pending]
  }

  resolveWith(record: RequestRecord, stream: FakeStream): void {
    const idx = this.pending.indexOf(record)
    if (idx >= 0) this.pending.splice(idx, 1)
    record.resolve(stream)
  }
}

function attachName(error: Error): Error {
  return error
}

export class FakeAudioNode implements AudioNodeLike {
  disconnectCount = 0
  connections: AudioNodeLike[] = []
  connect(destination: AudioNodeLike): void {
    this.connections.push(destination)
  }
  disconnect(): void {
    this.disconnectCount++
    this.connections = []
  }
}

export class FakeAudioParam {
  value = 1
  events: Array<{ value: number; at: number; method: string }> = []
  setValueAtTime(value: number, at: number): void {
    this.value = value
    this.events.push({ value, at, method: 'setValueAtTime' })
  }
  linearRampToValueAtTime(value: number, at: number): void {
    this.events.push({ value, at, method: 'linearRampToValueAtTime' })
  }
}

export class FakeGainNode extends FakeAudioNode implements GainNodeLike {
  gain = new FakeAudioParam()
}

export class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 1024
  /** 最近一次读取后可指定返回的波形振幅（-1..1 样本值）。 */
  sample = 0
  readCount = 0
  getByteTimeDomainData(array: Uint8Array): void {
    this.readCount++
    if (this.sample === 0) {
      array.fill(128)
      return
    }
    for (let i = 0; i < array.length; i++) {
      const v = Math.sin((i / array.length) * Math.PI * 4) * this.sample
      array[i] = Math.max(0, Math.min(255, Math.round(128 + v * 128)))
    }
  }
}

export class FakeAudioContext implements AudioContextLike {
  currentTime = 10
  state: 'suspended' | 'running' | 'closed' = 'suspended'
  destination = new FakeAudioNode()
  resumeShouldFail: string | null = null
  resumeCalls = 0
  closeCount = 0
  nodes = { source: 0, gain: 0, analyser: 0 }

  async resume(): Promise<void> {
    this.resumeCalls++
    if (this.resumeShouldFail) {
      const err = new Error(this.resumeShouldFail)
      ;(err as Error & { name: string }).name = 'NotAllowedError'
      throw err
    }
    this.state = 'running'
  }

  async close(): Promise<void> {
    this.closeCount++
    this.state = 'closed'
  }

  createMediaStreamSource(): AudioNodeLike {
    this.nodes.source++
    return new FakeAudioNode()
  }

  createGain(): FakeGainNode {
    this.nodes.gain++
    return new FakeGainNode()
  }

  createAnalyser(): FakeAnalyserNode {
    this.nodes.analyser++
    return new FakeAnalyserNode()
  }
}

export class FakeHost implements Host {
  ctx: FakeAudioContext | null = null
  createContextCount = 0
  noMediaDevices = false
  noAudioContext = false
  insecure = false
  /** 新创建的上下文首次 resume 即失败。 */
  resumeShouldFail: string | null = null

  constructor(public media: FakeMediaDevices) {}

  mediaDevices(): FakeMediaDevices | null {
    return this.noMediaDevices ? null : this.media
  }

  isSecureContext(): boolean {
    return !this.insecure
  }

  AudioContextCtor() {
    if (this.noAudioContext) return null
    // 能力检测只需构造器存在；引擎实际创建走 newAudioContext（可记录次数）。
    return function FakeCtor() {} as never
  }

  newAudioContext(): AudioContextLike | null {
    if (this.noAudioContext) return null
    return this.ensureCtx()
  }

  private ensureCtx(): FakeAudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new FakeAudioContext()
      this.ctx.resumeShouldFail = this.resumeShouldFail
      this.createContextCount++
    }
    return this.ctx
  }
}

/**
 * 可控调度器：raf/delay 只登记不自动执行，测试用 stepRaf/runFades 推进；
 * microtick 用真实微任务（await Promise.resolve 链）。
 */
export class ManualScheduler implements Scheduler {
  private rafs = new Map<number, () => void>()
  private timers = new Map<number, () => void>()
  private nextId = 1
  rafCalls = 0
  delayCalls: Array<{ ms: number }> = []

  raf(cb: () => void): number {
    this.rafCalls++
    const id = this.nextId++
    this.rafs.set(id, cb)
    return id
  }

  cancelRaf(id: number): void {
    this.rafs.delete(id)
  }

  delay(ms: number, cb: () => void): number {
    this.delayCalls.push({ ms })
    const id = this.nextId++
    this.timers.set(id, cb)
    return id
  }

  cancelDelay(id: number): void {
    this.timers.delete(id)
  }

  microtick(): Promise<void> {
    return Promise.resolve()
  }

  stepRaf(times = 1): void {
    for (let i = 0; i < times; i++) {
      const pending = [...this.rafs.entries()]
      this.rafs.clear()
      pending.forEach(([, cb]) => cb())
    }
  }

  runFades(): void {
    const pending = [...this.timers.entries()]
    this.timers.clear()
    pending.forEach(([, cb]) => cb())
  }

  pendingTimerCount(): number {
    return this.timers.size
  }
}

export function twoDevices(): MediaDeviceInfoLike[] {
  return [
    { deviceId: 'dev-primary', label: '主席台麦', kind: 'audioinput' },
    { deviceId: 'dev-backup', label: '同传箱备麦', kind: 'audioinput' },
  ]
}
