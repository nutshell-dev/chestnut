// phase 478: _helpers clip functions barrel re-export
export { clipPreview, clipMessage, clipSummary } from './_helpers.js';

// phase 753: lightweight diagnostic read helpers
// phase 1074: export discriminated result type alongside helpers
export {
  auditFileContains,
  auditFileGetMtime,
  auditFirstTimestamp,
} from './lightweight-read.js';

/**
 * @module L2a.AuditLog
 * AuditLog module (L2)
 *
 * 状态迁移审计记录。纯追加写。
 * 服务于"运行中产生的所有信息全量记录以供审计"。
 *
 * Resources: audit.tsv
 * Dependencies: FileSystem
 * Coupling: none
 * Consumers: Daemon, Runtime, ContractSystem, SubagentSystem
 *
 * 递归边界：AuditWriter 自身 write/rotation 失败是"审计的审计"死角，
 * 无法进入结构化事件流（会无限递归），唯一兜底是 console.error
 * 以 [AUDIT CRITICAL] 前缀输出。这是 L2 层唯一允许保留的 console 出口
 * （依赖 AuditLog 的其他 L2 模块不得效仿）。
 */

export type {
  AuditLog,
  AuditWriteOutcome,
  IdNamingEntry,
  ColSchemaEntry,
  TraceId,
  AuditFileName,
  AuditFileRoutingContribution,
  AuditArtifactRef,
  AuditLossRecord,
} from './types.js';
export { makeTraceId } from './types.js';
export { encodeAuditArtifact, encodeAuditLoss } from './artifact.js';

export { AUDIT_FILE, AUDIT_FILE_STEM, reconcileFallbackDumps } from './writer.js';
// phase 1786: reconcile malformed line typed evidence / outcome
// phase 1787: reconcile per-origin sync failure typed evidence / per-dump outcome
export type {
  ReconcileLine,
  ReconcileMalformedLine,
  FallbackReconcileResult,
  FallbackOriginResult,
  FallbackDumpReconcileOutcome,
} from './writer.js';
// phase 1788: audit 自观察失败受限 secondary channel（drop event write failure）
export type { AuditFailureReporter } from './writer.js';

// Phase 1288 Step B: audit namespace layout / config store
// （模块外消费一律经本 barrel；layout.ts 禁止 deep import）
// （phase 1890 Step L：migration journal 退役删除；publishAuditLayout 归 workspace-config）
export { AUDIT_LAYOUT_SCHEMA_VERSION, AUDIT_PATHS, AUDIT_LEGACY_PATHS } from './layout.js';
export {
  auditConfigSchema,
  type AuditConfig,
} from './config-schema.js';
export {
  loadWorkspaceAuditConfig,
  readWorkspaceAuditRetentionMaxSizeMb,
  initWorkspaceAuditConfig,
  publishAuditLayout,
} from './workspace-config.js';
// Phase 1288 Step C: workspace 根审计 capability（唯一生产构造入口；caller 不传路径/retention）
export { createWorkspaceAudit } from './workspace-audit.js';
// Phase 1288 Step D: workspace 根审计 segments typed 查询（legacy/new 双段显式列表、
// merged 时间序视图以 segment+offset 稳定 tie-break；逐段失败分型、不静默丢段）
export {
  listWorkspaceAuditSegments,
  readWorkspaceAuditMerged,
  type WorkspaceAuditSegmentIssue,
} from './workspace-segments.js';

// phase 693 Step A: audit 模块声明自家 ephemeral 资源 ignore list (M#3 single owner)
// Assembly 装配期 aggregate 各 owner 声明、注入 Snapshot ctor (per architecture §29)
export { AUDIT_SNAPSHOT_IGNORE } from './writer.js';

export { createDirContext } from './dir-context.js';

export { createSystemAudit, createAuditWriter } from './factory.js';
// phase 1893: fallback 静默 audit（完整接口面全 noop，免 as unknown as 裸 stub）
export { noopAuditLog } from './noop.js';
export { createHourlyHeartbeatAccumulator } from './hourly-heartbeat.js';
export { runAuditSizeMonitor, AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS } from './jobs/audit-size-monitor.js';

// Reader API (phase 126 + phase 147)
export {
  createAuditReader,
  listAuditFiles,
  listPendingFallbackDumps,
} from './reader.js';
export type {
  AuditRecord,
  ReadOptions,
  AuditFileInfo,
} from './reader.js';

// phase 1873 Step K: audit 尾部事件稳定读取 query（tsv 物理格式收口在 owner）
export { readLastAuditEvent } from './last-event.js';
export type { AuditEventRecord, LastAuditEventResult } from './last-event.js';
