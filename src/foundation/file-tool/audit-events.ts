/**
 * @module L2.FileTool.AuditEvents
 * NEW phase 684 / silent_x_audit_kit §2 audit 注入 α 模板（mirror phase 669）
 * phase 1443: NEW 5 events (4 new + 1 migrated from string-literal) for readFileState persistence
 * + overwrite gate decisions.
 */
export const FILE_TOOL_AUDIT_EVENTS = {
  /** sync-backup catch swallow → audit injection / phase 684 B-P2.10 / phase 706 L1-P1.1 dotcase → snake_case */
  BACKUP_FAILED: 'file_tool_backup_failed',

  /** read overflow > READ_OUTPUT_HARD_CAP_BYTES、persist 落盘失败（phase 1430 字面 → phase 1443 const） */
  READ_OVERFLOW_PERSIST_FAILED: 'read_overflow_persist_failed',

  /** readFileState mutation emit、payload: op=read|write|edit path=<resolved> isFullRead=<bool> (phase 1443) */
  READ_FILE_STATE_RECORDED: 'read_file_state_recorded',

  /** Runtime.initialize() 加载 readFileState、payload: result=ok|failed|parse_failed|skipped_unknown_version entry_count=<N> (phase 1443) */
  READ_FILE_STATE_LOADED: 'read_file_state_loaded',

  /** persist atomic write 失败 / clear delete 失败、payload: op=write|clear reason=<msg> (phase 1443) */
  READ_FILE_STATE_PERSIST_FAILED: 'read_file_state_persist_failed',

  /** write 工具 overwrite gate 拒绝、payload: path=<resolved> reason=not-read|partial|stale|verify-failed (phase 1443) */
  OVERWRITE_GATE_REJECTED: 'overwrite_gate_rejected',
} as const;
