/**
 * Viewport UI audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts VIEWPORT_ + CHAT_VIEWPORT_ 系列等价 / 0 漂移。
 */
export const VIEWPORT_AUDIT_EVENTS = {
  UI_CROSS_POLLUTION: 'viewport_ui_cross_pollution',
  EVENT_INGEST: 'viewport_event_ingest',
  RENDER_BATCH: 'viewport_render_batch',
  SPINNER_LIFECYCLE: 'viewport_spinner_lifecycle',
  SHUTDOWN: 'viewport_shutdown',
  WATCHER_FAILED: 'chat_viewport_watcher_failed',
  WATCHER_CALLBACK_FAILED: 'chat_viewport_watcher_callback_failed',
  UNKNOWN_EVENT: 'viewport_unknown_event',
  COMMAND_ERROR: 'viewport_command_error',
  CLAWSDIR_SCAN_FAILED: 'viewport_clawsdir_scan_failed',
  TASK_STREAM_STALE_CLEANUP: 'viewport_task_stream_stale_cleanup',
  TASK_WATCH_STOP_FAILED: 'viewport_task_watch_stop_failed',
  SCROLLBACK_CLEAR_SUPPRESSED: 'viewport_scrollback_clear_suppressed',
  INVALID_TASK_ID: 'chat_viewport_invalid_task_id',
  STREAM_READER_START_FAILED: 'chat_viewport_stream_reader_start_failed',
  HISTORY_REPLAY_FAILED: 'chat_viewport_history_replay_failed',
  REFRESH_CLAWS_FAILED: 'chat_viewport_refresh_claws_failed',
  ATTACHMENT_PERSIST_FAILED: 'viewport_attachment_persist_failed',
  INTERRUPT_PERSIST_FAILED: 'viewport_interrupt_persist_failed',
  DRAFT_PERSIST_FAILED: 'viewport_draft_persist_failed',
  DRAFT_PERSISTED: 'viewport_draft_persisted',
  DRAFT_RESTORE_FAILED: 'viewport_draft_restore_failed',
  DRAFT_RESTORED: 'viewport_draft_restored',
  DRAFT_QUARANTINED: 'viewport_draft_quarantined',
  DRAFT_CLEAR_FAILED: 'viewport_draft_clear_failed',
  DRAFT_CLEARED: 'viewport_draft_cleared',
} as const;

/**
 * Phase 159 业主声明 file 归属（phase 122 §5.A + §6.7）.
 *
 * viewport 高频 UI tick 类 → 'viewport' file、其余留 'audit'（默认主 file）.
 */
import type { FileSystem } from '../../foundation/fs/index.js';
import { createSystemAudit, type AuditLog } from '../../foundation/audit/index.js';

export const VIEWPORT_FILE_ROUTING: Readonly<Record<string, 'audit' | 'viewport'>> = {
  viewport_render_batch: 'viewport',
  viewport_event_ingest: 'viewport',
  viewport_spinner_lifecycle: 'viewport',
  viewport_scrollback_clear_suppressed: 'viewport',
  viewport_draft_persisted: 'viewport',
  viewport_draft_cleared: 'viewport',
} as const;

/**
 * Phase 1279 Step A: Chat Viewport owner 的唯一 AuditLog 工厂。
 *
 * 背景：Assembly 曾把 VIEWPORT_FILE_ROUTING 装进零 viewport producer 的 daemon
 * AuditLog，而两个真实 chat 入口（motion chat / claw chat）的单 writer 无 routing。
 * 现由 owner 自行兑现声明：routing 数据不出本模块，Record→ReadonlyMap 转换与
 * AuditLog 构造只在此处一份（M#7/M#8），两入口不复制转换。
 *
 * 边界：物理 audit.tsv / viewport.tsv 写入、rotation、seq 仍由 L2 AuditLog
 * （createSystemAudit / DispatchingAuditWriter）独占；本工厂只做业务构造（L6→L2）。
 * 未注册 / 非分流 viewport 事件按 DispatchingAuditWriter 默认兜底落 audit.tsv，
 * 无静默丢弃。
 */
export function createViewportAudit(fs: FileSystem, agentDir: string): AuditLog {
  return createSystemAudit(fs, agentDir, {
    typeToFile: new Map(Object.entries(VIEWPORT_FILE_ROUTING)),
  });
}
