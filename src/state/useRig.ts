import { useSyncExternalStore } from 'react';
import { RigEngine } from '../core/RigEngine';
import type { RigSnapshot } from '../core/types';

/**
 * 全局唯一引擎实例。纯前端：所有调用直接走浏览器真实
 * MediaDevices / Web Audio API，不存在任何网络或假接口。
 */
export const engine = new RigEngine();

export function useRig(): RigSnapshot {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}
