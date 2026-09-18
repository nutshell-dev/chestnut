/**
 * @module L4.ShadowSystem
 * phase 767 NEW
 * 业务语义：主代理一次性分身（完整继承上下文，能力等同主代理，同步阻塞）
 * 依赖：L3 SubAgent.runSubagent，L2 ToolProtocol（phase 769 后不直 dep DialogStore.restoreBefore、改 read ctx in-memory state）
 *
 * phase 1865 (SH-D10) 导出面按复用边界分列：
 * - 共享 primitives：Shadow ↔ Summon 唯一共享面（纯消息合成，无业务状态）；
 * - 装配面：shadow 自身工具/调度构造；spawnShadowSubagent 的跨模块复用形态待 1866 SU-D1 裁定；
 * - 契约面：供 phase 1863 E 消费的 payload 契约与构造器；
 * - 目录/策略常量：装配与 CLI 消费（归属见各常量注释）。
 */

// ── 共享 primitives（Shadow ↔ Summon 唯一共享面：纯消息合成）────────────────────
// phase 1142: primitives for L4 consumers（SummonSystem 契约创建子代理复用 primitive）
export { stripIncompleteToolUse } from './_helpers.js';

// ── 装配面（shadow 侧构造；跨模块复用裁定归 1866）──────────────────────────────
export { createShadowTool } from './tools/shadow.js';
// phase 1185: spawnShadowSubagent helper — shadow subagent 装配业务归位
export { spawnShadowSubagent } from './spawn-shadow-subagent.js';

// ── 契约面（1863 E 的消费面 import 点）────────────────────────────────────────
// phase 1865 (SH-D1): shadow 执行 payload 契约 + owner 构造器
export { buildShadowPayload } from './payload.js';
export type { ShadowExecutorPayload } from './types.js';

// ── 目录/策略常量（装配与 CLI 消费；归属注释见 constants.ts）────────────────────
export { TASKS_SYNC_SHADOW_DIR, SHADOW_DEFAULT_TIMEOUT_MS } from './constants.js';

// phase 1306: 删 dead re-export (buildShadowInstruction / _helpers.ts 已直接 import prompts/)
