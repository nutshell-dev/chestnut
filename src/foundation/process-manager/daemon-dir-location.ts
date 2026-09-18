/**
 * @module L2a.ProcessManager.DaemonDirLocation
 *
 * daemon 位置输入 → DaemonDir brand 的唯一 PM 侧构造 adapter。
 *
 * phase 1864 Step D（CT-D4）：品牌构造归 ProcessManager——caller（如 L4
 * ClawTopology）只提供已解析的位置事实，不自行构造 PM brand。
 * 输入为结构化参数（`kind: 'local'` + `clawDir`），与拓扑 owner 的 Location
 * 结构兼容；PM 不 import 拓扑模块（M#5 单向依赖）。
 */

import { makeDaemonDir, type DaemonDir } from './types.js';

/**
 * 已解析的 daemon 位置事实（结构化——拓扑 owner 的 Location.local 结构兼容）。
 * 未来分布式位置形态加入前、本 union 只有一个成员（伪能力不公开）。
 */
export interface DaemonDirLocation {
  readonly kind: 'local';
  readonly clawDir: string;
}

/**
 * PM-owned brand 构造：消费位置事实、返回 DaemonDir。
 *
 * Throws：无（位置合法性由解析方负责——拓扑侧 assertSafeClawId 链保留）。
 */
export function makeDaemonDirFromLocation(location: DaemonDirLocation): DaemonDir {
  return makeDaemonDir(location.clawDir);
}
