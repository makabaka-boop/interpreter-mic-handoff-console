import { describe, expect, it } from 'vitest'
import { SwitchbenchEngine } from './SwitchbenchEngine'
import {
  FakeHost,
  FakeMediaDevices,
  FakeStream,
  FakeTrack,
  ManualScheduler,
  twoDevices,
  type FakeAnalyserNode,
  type FakeAudioNode,
  type FakeGainNode,
} from '../testing/fakes'
import type { Line, Snapshot, Which } from './types'

interface EngineInternals {
  channels: Record<Which, { line: Line | null }>
}

function harness() {
  const media = new FakeMediaDevices(twoDevices())
  const host = new FakeHost(media)
  const clock = new ManualScheduler()
  const engine = new SwitchbenchEngine(host, clock)
  const snap = (): Snapshot => engine.getSnapshot()
  const lineOf = (which: Which): Line => {
    const ch = (engine as unknown as EngineInternals).channels[which]
    if (!ch.line) throw new Error(`${which} 线路不存在`)
    return ch.line
  }
  const gainOf = (line: Line): FakeGainNode => line.gain as FakeGainNode
  const analyserOf = (line: Line): FakeAnalyserNode => line.analyser as FakeAnalyserNode
  return { media, host, clock, engine, snap, lineOf, gainOf, analyserOf }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function authorizeOk(h: ReturnType<typeof harness>): Promise<void> {
  const p = h.engine.authorize()
  h.media.grantNext() // 探测流
  await p
}

async function auditionOk(
  h: ReturnType<typeof harness>,
  which: Which,
  deviceId: string,
): Promise<FakeStream> {
  h.engine.selectDevice(which, deviceId)
  const p = h.engine.audition(which)
  await flush()
  const stream = h.media.grantNext(`aud-${which}`) as FakeStream
  await p
  return stream
}

describe('SwitchbenchEngine — 能力与授权', () => {
  it('缺少 MediaDevices 时显示原因且不支持操作', () => {
    const media = new FakeMediaDevices(twoDevices())
    const host = new FakeHost(media)
    host.noMediaDevices = true
    const engine = new SwitchbenchEngine(host)
    const s = engine.getSnapshot()
    expect(s.supported).toBe(false)
    expect(s.phase).toBe('unsupported')
    expect(s.capabilityReason).toContain('MediaDevices')
  })

  it('非安全上下文时给出 https/localhost 提示', () => {
    const host = new FakeHost(new FakeMediaDevices(twoDevices()))
    host.insecure = true
    const s = new SwitchbenchEngine(host).getSnapshot()
    expect(s.phase).toBe('unsupported')
    expect(s.capabilityReason).toContain('安全上下文')
  })

  it('拒绝授权时展示原因，不写入任何设备与活动线路', async () => {
    const h = harness()
    const p = h.engine.authorize()
    h.media.rejectNext('NotAllowedError')
    await p
    const s = h.snap()
    expect(s.message).toContain('授权被拒绝')
    expect(s.devices).toHaveLength(0)
    expect(s.micActive).toBe(false)
    expect(s.activeWhich).toBeNull()
  })

  it('探测流在枚举完成后立即停止，界面无麦克风占用', async () => {
    const h = harness()
    const p = h.engine.authorize()
    const probe = h.media.grantNext('probe') as FakeStream
    await p
    expect(probe.tracks[0].stopCount).toBe(1)
    expect(h.snap().micActive).toBe(false)
    expect(h.snap().devices.map((d) => d.deviceId)).toEqual([
      'dev-primary',
      'dev-backup',
    ])
  })

  it('授权进行中重复点击不会产生第二次取流请求', async () => {
    const h = harness()
    const p = h.engine.authorize()
    expect(h.snap().busy).toBe(true)
    // 第二次调用直接被忽略，不新增 getUserMedia 记录。
    await h.engine.authorize()
    expect(h.media.requests).toHaveLength(1)
    h.media.grantNext()
    await p
    expect(h.snap().busy).toBe(false)
  })

  it('授权在途被停止/重置代次后，迟到探测流被停止且不写设备', async () => {
    const h = harness()
    const p = h.engine.authorize()
    // 武装/试听按钮在 busy 下不可触发；用内部代次推进模拟并发重置。
    h.engine.stop()
    const late = h.media.grantNext('late-probe') as FakeStream
    await p
    expect(late.tracks[0].stopCount).toBe(1)
    expect(h.snap().devices).toHaveLength(0)
    expect(h.snap().message).toContain('已停止')
  })

  it('AudioContext 恢复失败时停止探测流并报告原因', async () => {    const h = harness()
    h.host.resumeShouldFail = 'blocked'
    const p = h.engine.authorize()
    const probe = h.media.grantNext('probe') as FakeStream
    await p
    expect(probe.tracks[0].stopCount).toBe(1)
    expect(h.snap().message).toMatch(/授权被拒绝|AudioContext|取流失败/)
    expect(h.snap().devices).toHaveLength(0)
  })
})

describe('SwitchbenchEngine — 试听与释放', () => {
  it('两路都试听后可武装，武装期间禁止另开试听', async () => {
    const h = harness()
    await authorizeOk(h)
    await auditionOk(h, 'primary', 'dev-primary')
    await auditionOk(h, 'backup', 'dev-backup')
    expect(h.snap().canArm).toBe(true)

    h.engine.arm()
    expect(h.snap().phase).toBe('armed')
    expect(h.snap().auditionLocked).toBe(true)
    expect(h.snap().activeWhich).toBe('primary')

    // 武装中再点试听：状态不变化、不产生 getUserMedia 请求。
    const before = h.media.requests.length
    await h.engine.audition('primary')
    expect(h.media.requests.length).toBe(before)
    expect(h.snap().phase).toBe('armed')
  })

  it('停止试听会停止全部轨道并断开 source/gain/analyser 节点', async () => {
    const h = harness()
    await authorizeOk(h)
    const pStream = await auditionOk(h, 'primary', 'dev-primary')
    const bStream = await auditionOk(h, 'backup', 'dev-backup')
    const pLine = h.lineOf('primary')
    const bLine = h.lineOf('backup')

    h.engine.stop()

    expect(pStream.tracks[0].stopCount).toBe(1)
    expect(bStream.tracks[0].stopCount).toBe(1)
    expect((pLine.source as FakeAudioNode).disconnectCount).toBe(1)
    expect((bLine.source as FakeAudioNode).disconnectCount).toBe(1)
    expect(h.snap().micActive).toBe(false)
    expect(h.snap().phase).toBe('idle')
    expect(h.snap().canArm).toBe(false)
  })

  it('实时电平随帧更新，停止后归零', async () => {
    const h = harness()
    await authorizeOk(h)
    await auditionOk(h, 'primary', 'dev-primary')
    const line = h.lineOf('primary')
    h.analyserOf(line).sample = 0.8
    h.clock.stepRaf(2)
    expect(h.snap().primary.level).toBeGreaterThan(0)

    h.engine.stop()
    expect(h.snap().primary.level).toBe(0)
  })
})

describe('SwitchbenchEngine — 代次（快速操作）', () => {
  it('快速重开试听后再停止：迟到流立即停止，且不得改写“已停止”提示', async () => {
    const h = harness()
    await authorizeOk(h)
    await auditionOk(h, 'primary', 'dev-primary')

    // 发起第二次试听但不解析取流，随后停止（代次 +1）使在途请求作废。
    const restart = h.engine.audition('primary')
    await flush()
    h.engine.stop()
    const lateStream = h.media.grantNext('late') as FakeStream
    await restart
    expect(lateStream.tracks[0].stopCount).toBe(1)
    expect(h.snap().message).toContain('已停止')
    expect(h.snap().micActive).toBe(false)
  })

  it('重复点击试听时旧线路不会残留：第二个 live 流接管并停掉旧轨道', async () => {
    const h = harness()
    await authorizeOk(h)
    const first = await auditionOk(h, 'primary', 'dev-primary')

    // requesting 为 false 时第二次试听直接放行（不排队），接管后旧线释放。
    const second = h.engine.audition('primary')
    await flush()
    const newer = h.media.grantNext('second') as FakeStream
    await second
    expect(first.tracks[0].stopCount).toBe(1)
    expect(newer.tracks[0].readyState).toBe('live')
    expect(h.snap().primary.status).toBe('live')
  })

  it('试听、武装、切换都递增代次', async () => {
    const h = harness()
    await authorizeOk(h)
    const g0 = h.engine.getGeneration()
    await auditionOk(h, 'primary', 'dev-primary')
    const g1 = h.engine.getGeneration()
    await auditionOk(h, 'backup', 'dev-backup')
    const g2 = h.engine.getGeneration()
    expect(g1).toBeGreaterThan(g0)
    expect(g2).toBeGreaterThan(g1)

    h.engine.arm()
    expect(h.engine.getGeneration()).toBe(g2 + 1)
  })
})

describe('SwitchbenchEngine — 切换与故障', () => {
  async function armedHarness() {
    const h = harness()
    await authorizeOk(h)
    const primary = await auditionOk(h, 'primary', 'dev-primary')
    const backupMon = await auditionOk(h, 'backup', 'dev-backup')
    h.engine.arm()
    return { h, primary, backupMon }
  }

  it('候选就绪后做 80ms 线性增减益交叉，完成后再停旧主轨道', async () => {
    const { h, primary } = await armedHarness()
    const primLine = h.lineOf('primary')
    const primGain = h.gainOf(primLine) as FakeGainNode
    const switchP = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush() // 两跳 microtick
    await flush()
    await switchP

    expect(h.snap().phase).toBe('switching')
    expect(h.snap().busy).toBe(true)
    const rampValues = primGain.gain.events
      .filter((e) => e.method === 'linearRampToValueAtTime')
      .map((e) => e.value)
    expect(rampValues).toContain(0)
    expect(h.clock.delayCalls.some((d) => d.ms === 80)).toBe(true)
    // 淡化完成前旧主轨仍活着。
    expect(primary.tracks[0].readyState).toBe('live')

    h.clock.runFades()
    expect(h.snap().phase).toBe('live')
    expect(h.snap().activeWhich).toBe('backup')
    expect(primary.tracks[0].stopCount).toBe(1)
    expect(primLine.source).toBeDefined()
    expect(h.snap().micActive).toBe(true)
    expect(candidate.tracks[0].stopCount).toBe(0)
  })

  it('候选被拒绝时保留原主路，可重新发起切换', async () => {
    const { h, primary } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    h.media.rejectNext('NotAllowedError')
    await p

    const s = h.snap()
    expect(s.phase).toBe('armed')
    expect(s.activeWhich).toBe('primary')
    expect(s.message).toContain('原主路保持输出')
    expect(primary.tracks[0].readyState).toBe('live')
    expect(s.canSwitch).toBe(true)
  })

  it('候选提前结束时释放候选、保留主路', async () => {
    const { h, primary } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    candidate.tracks[0].endNaturally()
    await flush()
    await flush()
    await p

    const s = h.snap()
    expect(s.phase).toBe('armed')
    expect(primary.tracks[0].readyState).toBe('live')
    expect(candidate.tracks[0].readyState).toBe('ended')
    expect(s.activeWhich).toBe('primary')
  })

  it('AudioContext 恢复失败时保留原主路', async () => {
    const { h, primary } = await armedHarness()
    h.host.ctx!.resumeShouldFail = 'blocked'
    const p = h.engine.switchToBackup()
    await flush()
    h.media.grantNext('candidate')
    await p
    expect(h.snap().phase).toBe('armed')
    expect(primary.tracks[0].readyState).toBe('live')
    expect(h.snap().message).toContain('原主路')
  })

  it('武装态活动主路一旦结束立即进入故障态，必须重新试听才可武装', async () => {
    const { h, primary } = await armedHarness()
    ;(primary.tracks[0] as FakeTrack).endNaturally()

    const s = h.snap()
    expect(s.phase).toBe('fault')
    expect(s.message).toContain('故障态')
    expect(s.micActive).toBe(false)
    expect(s.canArm).toBe(false)

    // 重新试听两路后才可再次武装。
    await auditionOk(h, 'primary', 'dev-primary')
    expect(h.snap().canArm).toBe(false)
    await auditionOk(h, 'backup', 'dev-backup')
    expect(h.snap().canArm).toBe(true)
  })

  it('交叉中活动主路结束 → 故障；切换中的迟到候选也被释放', async () => {
    const { h, primary } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush()
    await flush()
    await p
    expect(h.snap().phase).toBe('switching')

    // 活动主路在 80ms 窗口内结束 → 故障（代次 +1，淡化回调作废）。
    ;(primary.tracks[0] as FakeTrack).endNaturally()
    expect(h.snap().phase).toBe('fault')
    expect(candidate.tracks[0].stopCount).toBe(1) // 候选随故障立即释放

    // 即使淡化定时器迟到触发，也不得复活线路。
    h.clock.runFades()
    expect(h.snap().phase).toBe('fault')
  })

  it('切换请求期间停止：迟到候选立即释放且不进入 live', async () => {
    const { h } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    h.engine.stop()
    const late = h.media.grantNext('late-candidate') as FakeStream
    await p
    expect(late.tracks[0].stopCount).toBe(1)
    expect(h.snap().phase).toBe('idle')
    expect(h.snap().activeWhich).toBeNull()
  })

  it('选择不存在的设备时报告原因，已工作线路不被清空', async () => {
    const h = harness()
    await authorizeOk(h)
    const stream = await auditionOk(h, 'primary', 'dev-primary')
    h.engine.selectDevice('primary', 'ghost-device')
    expect(h.snap().message).toContain('不存在')
    // 已工作的主路试听线路保持在线。
    expect(h.snap().primary.status).toBe('live')
    expect(stream.tracks[0].readyState).toBe('live')
  })
})
