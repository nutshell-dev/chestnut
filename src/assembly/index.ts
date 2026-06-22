/**
 * @module L6.Assembly
 * Assembly — 运行时依赖组装与注入。
 */

export { LockConflictError } from '../foundation/process-manager/index.js';
export type { Identity, AssembleConfig, Instances } from './types.js';

export { assemble } from './assemble.js';
export { disassemble } from './disassemble.js';

// phase 1413+1448: Assembly 对外表面显式暴露通道（pre-assemble shared const + events + patterns）。
// CONFIG_DEFAULTS / ASSEMBLY_AUDIT_EVENTS 二 const 跨 L3 core/* + L5
// watchdog 业主、M#5 客观约束聚合必寓 L6。跨模块 caller（cli/daemon-entry/watchdog）pre-assemble
// 阶段需消费 → barrel re-export。
// 显式 ratify (M#9 不可消除耦合应显式表达)。depcruise 3 forbidden rule
// `no-deep-into-assembly-{config-defaults,audit-events}` 守 future drift。
// 注：daemon-entry / watchdog-entry 物理路径解析归 `assembly/spawn-entry.ts`
// `resolveDaemonEntry` / `resolveWatchdogEntry`（phase 1436 立单一权威、phase 72 迁 L6 Assembly）。
// Note: CONFIG_DEFAULTS removed in phase 10 Step D (config decentralize)
export { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';

// phase 693: SNAPSHOT_IGNORE_PATTERNS 归 Assembly 装配组装、各 owner module 声明自家 *_SNAPSHOT_IGNORE。
// 与 architecture §29 严格一致。lint `no-deep-into-assembly-snapshot-patterns` 守 barrel-only。
export { SNAPSHOT_IGNORE_PATTERNS } from './snapshot-patterns.js';

