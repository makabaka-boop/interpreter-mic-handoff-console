/**
 * 核心域类型：与 React 无关，Vitest 直接驱动。
 */

export type Role = 'primary' | 'backup';

/** 单条通道（主/备）的生命周期状态 */
export type ChannelPhase =
  | 'idle' // 未试听
  | 'auditioning' // 正在申请/建链
  | 'live-audition' // 试听中（耳返有输出）
  | 'stopping' // 正在关闭
  | 'fault'; // 活动主路意外结束后的故障态

/** 权限状态 */
export type PermissionStateKind =
  | 'unsupported' // 缺少 MediaDevices 等基础能力
  | 'idle' // 尚未授权
  | 'prompting' // 浏览器授权弹窗中
  | 'granted' // 已授权（拿到过一次设备流）
  | 'denied'; // 用户拒绝 / 权限失败

/** 整机阶段 */
export type RigPhase =
  | 'no-support'
  | 'idle' // 未武装
  | 'arming' // 武装中（备用试听已停止，主路保持输出）
  | 'armed' // 已武装，等待发起切换
  | 'switching' // 切换中：备用就绪 -> 80ms 交叉 -> 停旧主
  | 'running-backup' // 已切到备用，须停止后重新试听才能再次武装
  | 'fault';

export interface DeviceItem {
  deviceId: string;
  label: string;
}

export interface ChannelSnapshot {
  role: Role;
  phase: ChannelPhase;
  deviceId: string | null;
  /** 最近一次试听成功的设备，武装判断用 */
  auditionedDeviceId: string | null;
  /** 该路是否为当前活动输出 */
  active: boolean;
  /** 实时电平 0..1，rAF 更新 */
  level: number;
}

export interface EngineMessage {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warn';
  text: string;
}

export interface RigSnapshot {
  phase: RigPhase;
  permission: PermissionStateKind;
  isSecureContext: boolean;
  hasWebAudio: boolean;
  primary: ChannelSnapshot;
  backup: ChannelSnapshot;
  devices: DeviceItem[];
  /** 是否仍有任一麦克风处于占用状态（用于停止后确认无残留） */
  micInUse: boolean;
  messages: EngineMessage[];
  can: {
    requestPermission: boolean;
    auditionPrimary: boolean;
    auditionBackup: boolean;
    arm: boolean;
    switch: boolean;
    stop: boolean;
  };
}

/** 引擎运行所需浏览器能力，构造时注入；生产用真实实现，测试用可控替身 */
export interface RigEnv {
  mediaDevices: MediaDevices | null;
  AudioContextCtor: typeof AudioContext | null;
  isSecureContext: boolean;
}

/** 引擎内部一条已建立的音频线路 */
export interface LiveLine {
  role: Role | 'candidate';
  stream: MediaStream;
  tracks: MediaStreamTrack[];
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  /** 该线路是否承担“活动主输出”（意外结束要进故障态） */
  activePrimary: boolean;
}
