/**
 * @module L6.Daemon.EntryResolver
 * daemon-entry.js 入口路径解析 + bundle 判别（phase 1284 自 assembly/spawn-entry.ts 归位
 * Daemon 真 owner；phase 1436 抽象、phase 72 曾迁 L6 Assembly）。
 *
 * 业务：Daemon 进程入口资源 `daemon-entry.js` 的物理路径定位、跨 bundled (tsup
 * 平铺至 dist/) vs unbundled (tsc 保 src 层级 dist/daemon/) 模式自动判别。
 *
 * 模式判别基础：basename 比较纯路径结构、无 fs 依赖。signature 零参数（phase 1284
 * 删除从未消费的 `_fs?` 伪依赖）。
 *
 * 稳定子入口：CLIProcess / Watchdog 经 `daemon/entry-resolver.js` 直接消费，不经
 * `daemon/index.js` 宽 barrel（路径查询不加载 Daemon 运行实现）。
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

const ENTRY_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// basename 字面 'daemon'：unbundled dist 层级 dist/daemon/ basename = 'daemon'；
// bundled tsup 平铺至 dist/ basename ≠ 'daemon'
const IS_BUNDLED = path.basename(ENTRY_MODULE_DIR) !== 'daemon';

export function resolveDaemonEntry(): string {
  return IS_BUNDLED
    ? path.join(ENTRY_MODULE_DIR, 'daemon-entry.js')
    : path.resolve(ENTRY_MODULE_DIR, '..', 'daemon-entry.js');
}
