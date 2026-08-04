/**
 * @module L6.Watchdog.EntryResolver
 * watchdog-entry.js 入口路径解析 + bundle 判别（phase 1285 自 assembly/spawn-entry.ts 归位
 * Watchdog 真 owner；phase 1436 抽象、phase 72 曾迁 L6 Assembly）。
 *
 * 业务：Watchdog 进程入口资源 `watchdog-entry.js` 的物理路径定位、跨 bundled (tsup
 * 平铺至 dist/) vs unbundled (tsc 保 src 层级 dist/watchdog/) 模式自动判别。
 *
 * 模式判别基础：basename 比较纯路径结构、无 fs 依赖。signature 零参数（phase 1285
 * 删除从未消费的 `_fs?` 伪依赖）。
 *
 * 消费方式：Watchdog 内部经本模块直接消费；外部（CLIProcess）经
 * `watchdog-context.ts` 零参数公共查询 `getWatchdogEntryPath()` 委托，不 deep-import
 * 本文件（路径查询不暴露内部 resolver 边界）。
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

const ENTRY_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// basename 字面 'watchdog'：unbundled dist 层级 dist/watchdog/ basename = 'watchdog'；
// bundled tsup 平铺至 dist/ basename ≠ 'watchdog'
const IS_BUNDLED = path.basename(ENTRY_MODULE_DIR) !== 'watchdog';

export function resolveWatchdogEntry(): string {
  return IS_BUNDLED
    ? path.join(ENTRY_MODULE_DIR, 'watchdog-entry.js')
    : path.resolve(ENTRY_MODULE_DIR, '..', 'watchdog-entry.js');
}
