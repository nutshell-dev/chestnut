/**
 * @module L6.Assembly
 * Assembly — 运行时依赖组装与注入。
 */

export { LockConflictError } from '../foundation/process-manager/index.js';
export type { Identity, AssembleConfig, Instances } from './types.js';

export { assemble } from './assemble.js';
export { disassemble } from './disassemble.js';

// phase 1413: pre-assemble defaults re-export — Assembly 对外表面显式暴露通道。
// CONFIG_DEFAULTS 8 owner const 跨 L3 core/* + L5 watchdog、ML#5 客观约束聚合必寓 L6。
// 跨模块 caller (cli/daemon-entry/watchdog) pre-assemble 阶段需消费 → barrel re-export
// 注：daemon-entry / watchdog-entry 物理路径解析归 `foundation/paths.ts`
// `resolveDaemonEntry` / `resolveWatchdogEntry`（phase 1436 立单一权威）。
// 显式 ratify (ML#9 不可消除耦合应显式表达)。depcruise `no-deep-into-assembly-config-defaults`
// 守 future drift。
//
// scope note: phase 1413 row `A.phase1413-config-defaults-exposure-channel` 仅治 CONFIG_DEFAULTS。
// sister deep import（`SNAPSHOT_IGNORE_PATTERNS` from snapshot-patterns.ts /
// `ASSEMBLY_AUDIT_EVENTS` from audit-events.ts）属同型 drift、留 follow-up phase 治
// （需配套修 tests/cli/stop-orphan-* total mock → partial mock with importOriginal）。
export { CONFIG_DEFAULTS } from './config-defaults.js';
