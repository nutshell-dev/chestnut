/**
 * @module L4.ShadowSystem
 * phase 767 NEW
 * 业务语义：主代理一次性分身（完整继承上下文，能力等同主代理，同步阻塞）
 * 依赖：L3 SubAgent.runSubagent，L2 ToolProtocol（phase 769 后不直 dep DialogStore.restoreBefore、改 read ctx in-memory state）
 */

export { shadowTool, SHADOW_TOOL_NAME } from './tools/shadow.js';
export { SHADOW_AUDIT_EVENTS } from './audit-events.js';
export { TASKS_SYNC_SHADOW_DIR } from './constants.js';
