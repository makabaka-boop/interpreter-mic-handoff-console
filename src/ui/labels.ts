import type {
  ChannelPhase,
  PermissionStateKind,
  RigPhase,
} from '../core/types';

export const ROLE_LABEL = { primary: '主输入', backup: '备输入' } as const;

export function channelPhaseText(phase: ChannelPhase): string {
  switch (phase) {
    case 'idle':
      return '未试听';
    case 'auditioning':
      return '申请中…';
    case 'live-audition':
      return '试听中（耳返输出）';
    case 'stopping':
      return '停止中…';
    case 'fault':
      return '故障';
  }
}

export function channelPhaseBadge(
  phase: ChannelPhase,
): 'ok' | 'warn' | 'err' | 'info' {
  switch (phase) {
    case 'live-audition':
      return 'ok';
    case 'auditioning':
    case 'stopping':
      return 'info';
    case 'fault':
      return 'err';
    case 'idle':
      return 'warn';
  }
}

export function permissionText(p: PermissionStateKind): string {
  switch (p) {
    case 'unsupported':
      return '浏览器不支持';
    case 'idle':
      return '未授权';
    case 'prompting':
      return '授权请求中';
    case 'granted':
      return '已授权';
    case 'denied':
      return '已拒绝';
  }
}

export function permissionBadge(
  p: PermissionStateKind,
): 'ok' | 'warn' | 'err' | 'info' {
  switch (p) {
    case 'granted':
      return 'ok';
    case 'prompting':
      return 'info';
    case 'denied':
    case 'unsupported':
      return 'err';
    case 'idle':
      return 'warn';
  }
}

export function rigPhaseText(p: RigPhase): string {
  switch (p) {
    case 'no-support':
      return '能力不支持';
    case 'idle':
      return '待命';
    case 'arming':
      return '武装中';
    case 'armed':
      return '主路已武装';
    case 'switching':
      return '切换中';
    case 'running-backup':
      return '备用运行中';
    case 'fault':
      return '故障';
  }
}

export function rigPhaseBadge(
  p: RigPhase,
): 'ok' | 'warn' | 'err' | 'info' {
  switch (p) {
    case 'idle':
      return 'info';
    case 'armed':
    case 'arming':
      return 'warn';
    case 'switching':
      return 'info';
    case 'running-backup':
      return 'ok';
    case 'fault':
    case 'no-support':
      return 'err';
  }
}
