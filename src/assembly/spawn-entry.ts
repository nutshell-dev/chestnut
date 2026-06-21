/**
 * @module L6.Assembly.SpawnEntry
 * spawn daemon / watchdog entry 路径解析 + bundle 判别（phase 1436 抽象、phase 72 自
 * foundation/paths.ts 整迁 → L6 Assembly 真业务 owner）。
 *
 * 业务：装配期决定 daemon-entry.js / watchdog-entry.js 物理路径、跨 bundled (tsup
 * 平铺至 dist/) vs unbundled (tsc 保 src 层级 dist/assembly/) 模式自动判别。
 *
 * 模式判别基础：basename 比较纯路径结构、无 fs 依赖。
 *
 * 散落历史（phase 1436 之前）：7 cli/commands + 1 watchdog 共 8 caller 各自手算
 * 路径、3 种 fallback 层数 + 2 种 exists 判定 = 6 种写法。tsup code-split 平铺策略
 * 一改即全炸（toolprotocol-rechecker / messaging-auditor / tools-auditor daemon spawn
 * MODULE_NOT_FOUND 实证）。
 *
 * signature 保 `(_fs?: FileSystem)`：caller 调用形式与既有 `existsSync` 风格一致、
 * 未来若 entry 路径源迁回 user fs（罕见）签名不破。当前实现不消费 fs 参数。
 *
 * cluster L1-L4 去 claw 化 / paths.ts 解散第三步、详
 * `coding plan/cluster-claw-decoupling-roadmap.md`。
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import type { FileSystem } from '../foundation/fs/index.js';

const PATHS_THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
// phase 72: basename 字面 'foundation' → 'assembly'（spawn entry 物理迁、unbundled
// dist 层级 dist/assembly/ basename = 'assembly'）
const PATHS_IS_BUNDLED = path.basename(PATHS_THIS_DIR) !== 'assembly';

export function resolveDaemonEntry(_fs?: FileSystem): string {
  return resolveSpawnEntry('daemon-entry.js');
}

export function resolveWatchdogEntry(_fs?: FileSystem): string {
  return resolveSpawnEntry('watchdog-entry.js');
}

function resolveSpawnEntry(filename: string): string {
  if (PATHS_IS_BUNDLED) return path.join(PATHS_THIS_DIR, filename);
  return path.resolve(PATHS_THIS_DIR, '..', filename);
}
