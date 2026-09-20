/**
 * @module L6.Assembly
 * Assembly — 运行时依赖组装与注入。
 */

export type { Identity, AssembleConfig, Instances, AssemblyContributions, AssembleOverrides } from './types.js';

export { assemble } from './assemble.js';

// phase 1413+1448: Assembly 对外表面显式暴露通道（pre-assemble shared const + events + patterns）。
// CONFIG_DEFAULTS / ASSEMBLY_AUDIT_EVENTS 二 const 跨 L3 core/* + L5
// watchdog 业主、M#5 客观约束聚合必寓 L6。跨模块 caller（cli/daemon-entry/watchdog）pre-assemble
// 阶段需消费 → barrel re-export。
// 显式 ratify (M#9 不可消除耦合应显式表达)。depcruise 3 forbidden rule
// `no-deep-into-assembly-{config-defaults,audit-events}` 守 future drift。
// 注：watchdog entry 物理路径解析 phase 1285 归位 Watchdog 真 owner
// `watchdog/entry-resolver.ts`（assembly/spawn-entry.ts 已删除）；
// daemon entry 路径解析 phase 1284 归位 Daemon 真 owner `daemon/entry-resolver.ts`。
// Note: CONFIG_DEFAULTS removed in phase 10 Step D (config decentralize)
export { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';

// phase 693: SNAPSHOT_IGNORE_PATTERNS 归 Assembly 装配组装、各 owner module 声明自家 *_SNAPSHOT_IGNORE。
// 与 architecture §29 严格一致。lint `no-deep-into-assembly-snapshot-patterns` 守 barrel-only。
export { SNAPSHOT_IGNORE_PATTERNS } from './config/snapshot-patterns.js';

// phase 1300 Step A: Assembly RootConfig 稳定 capability（M#8 最小表面）。
// 只导出 factory、resolver 与三种接口类型；config-load 离散函数、path helper、
// generic ConfigStore 与 legacy migration 原语不进入 barrel（临时兼容出口，
// 后续 CLI/Daemon 迁移 phase 消化）。
export { createRootConfig, createRootConfigLegacyMigration } from './config/root-config.js';
export type { RootConfigReader, RootConfigAdmin, RootConfigDeps, RootConfigLegacyMigration } from './config/root-config.js';
export { resolveLLMConfig } from './config/config-load.js';
export { initializeClawLayout } from './claw-subdirs.js';
export { ASSEMBLY_STREAM_EVENTS } from './stream-events.js';
export type { ClawGlobalConfig } from './config/compose-config.js';
export { wireClawTopology } from './wire-claw-topology.js';
// phase 1874 Step F: contract CLI action 窄装配入口（装配语义归 Assembly）
export { createContractActionContext, createClawContractAudit } from './contract-action.js';
export type { ContractActionContext, ClawActionAudit, ContractActionFsDeps } from './contract-action.js';
export { createCrossTargetAccess } from './cross-target-access.js';
