/**
 * @module L2c.FileTool.AuditEvents
 * NEW phase 684 / silent_x_audit_kit §2 audit 注入 α 模板（mirror phase 669）
 * phase 1443: NEW 5 events (4 new + 1 migrated from string-literal) for readFileState persistence
 * + overwrite gate decisions.
 */
export const FILE_TOOL_AUDIT_EVENTS = {
  /** sync-backup catch swallow → audit injection / phase 684 B-P2.10 / phase 706 L1-P1.1 dotcase → snake_case */
  BACKUP_FAILED: 'file_tool_backup_failed',

  /** phase 1109 Step C: edit committed successfully、payload: tool path before_hash after_hash backup_path replaced edit_count */
  FILE_EDIT_COMMITTED: 'file_edit_committed',

  /** phase 1109 Step C: pre-commit content hash conflict、payload: tool path before_hash current_hash stage=precommit */
  FILE_EDIT_CONFLICT: 'file_edit_conflict',

  /** phase 1109 Step C: edit backup failed → fail closed、payload: tool path before_hash reason */
  FILE_EDIT_BACKUP_FAILED: 'file_edit_backup_failed',

  /** phase 1109 Step C: post-write verification failed、payload: tool path expected_hash actual_hash backup_path */
  FILE_EDIT_VERIFICATION_FAILED: 'file_edit_verification_failed',

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
  READ_FILE_STATE_INVARIANT_VIOLATED: 'read_file_state_invariant_violated',
  // NEW phase 272 Step B: raw audit emit migration to const SoT
  SEARCH_OVERFLOW_PERSIST_FAILED: 'search_overflow_persist_failed',

  /** Zod strict parse 拒绝非法 tool input、payload: tool=<name> error=<msg> (phase 305) */
  INPUT_VALIDATION_FAILED: 'file_tool_input_validation_failed',
} as const;

/**
 * Phase 159 业主声明 file 归属（phase 122 §5.A + §6.7）.
 */
export const FILE_TOOL_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  search_overflow_persist_failed: 'audit',
} as const;
