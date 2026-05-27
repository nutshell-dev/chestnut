/**
 * @module L5.StatusService
 *
 * StatusService — agent 自我状态聚合 introspection 服务（read-only / 0 自有资源 / 0 持久化）
 *
 * 应然：
 * - own statusTool schema + execute（contract view + tasks count + storage stats）
 * - own STATUS_AUDIT_EVENTS 模块自治命名空间
 * - statusTool 直 dep ContractSystem（phase458 删 port / 内联 view 计算）
 * - L5 服务（与 Runtime / Cron / Gateway 同层）
 *
 * Phase 446 物理立 / 业务工具归 owner module 第 5 实证。
 */

export { createStatusTool, STATUS_TOOL_NAME } from './status-tool.js';
export { STATUS_AUDIT_EVENTS } from './audit-events.js';
