/**
 * @module L5.StatusService
 *
 * StatusService — agent 自我状态聚合 introspection 服务（read-only / 0 自有资源 / 0 持久化）
 *
 * 应然：
 * - own statusTool schema + execute（contract view + tasks count + storage stats）
 * - own STATUS_AUDIT_EVENTS 模块自治命名空间
 * - own aggregators（pure data views）+ format helpers — agent tool 与 CLI `claw <name> status` 共用
 * - statusTool 直 dep ContractSystem（phase458 删 port / 内联 view 计算）
 * - L5 服务（与 Runtime / Cron / Gateway 同层）
 *
 * Phase 446 物理立 / 业务工具归 owner module 第 5 实证。
 * Phase 1472 Step A：抽 aggregator + format helper、让 CLI `claw <name> status` 共用。
 * Phase 1478 Step A：加 forum-level aggregator + formatter（system + active claws 聚合）
 *   给 `clawforum status` CLI 用、与 per-claw aggregator 平行（进程层 vs 业务层）。
 */

export { createStatusTool, STATUS_TOOL_NAME } from './status-tool.js';
export { STATUS_AUDIT_EVENTS } from './audit-events.js';
export {
  computeContractView,
  computeTaskView,
  computeStorageView,
  formatContractView,
  formatTaskView,
  formatStorageView,
} from './aggregators.js';
export type {
  ContractView,
  TaskView,
  StorageMemoryView,
  StorageClawspaceView,
  StorageView,
} from './aggregators.js';
export {
  STATUS_MOTION_GUIDANCE_FACTS,
  formatMotionGuidance,
} from './motion-guidance.js';
export type {
  StatusMotionGuidanceFacts,
  StatusMotionGuidanceVerb,
  StatusMotionGuidance,
} from './motion-guidance.js';
export {
  computeProcessUptimeMs,
  computeClawInboxUnread,
  computeClawLastActivityAgoMs,
  computeForumStatusView,
  findOrphans,
} from './forum-aggregators.js';
export type {
  SystemComponentView,
  ActiveClawView,
  OrphansView,
  ForumStatusView,
  ForumStatusDeps,
} from './forum-aggregators.js';
export { formatForumStatusView, humanizeUptime, humanizeAgo } from './forum-formatter.js';
