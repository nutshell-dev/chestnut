/**
 * @module L4.ShadowSystem
 * phase 767 NEW
 * 业务语义：主代理一次性分身（完整继承上下文，能力等同主代理，同步阻塞）
 * 依赖：L3 SubAgent.runSubagent，L2 ToolProtocol（phase 769 后不直 dep DialogStore.restoreBefore、改 read ctx in-memory state）
 */

export { createShadowTool } from './tools/shadow.js';
export { SHADOW_TOOL_NAME } from './constants.js';
export { SHADOW_AUDIT_EVENTS } from './audit-events.js';
export { TASKS_SYNC_SHADOW_DIR } from './constants.js';
// phase 1142: primitives for L4 consumers (SummonSystem.shadow mode)
export { synthesizeFormB, stripIncompleteToolUse } from './_helpers.js';
// phase 1306: 删 dead re-export (buildShadowInstruction / _helpers.ts 已直接 import prompts/)
// phase 1185: spawnShadowSubagent helper — shadow subagent 装配业务归位
export { spawnShadowSubagent } from './spawn-shadow-subagent.js';
export type { SpawnShadowSubagentOptions, SpawnShadowSubagentResult } from './types.js';
