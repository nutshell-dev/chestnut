export const CLAW_TOPOLOGY_AUDIT_EVENTS = {
  CROSS_CLAW_READ_FAILED: 'cross_claw_read_failed',
  CROSS_CLAW_RESOLVE_FAILED: 'cross_claw_resolve_failed',
  CROSS_CLAW_BROADCAST_MOTION_ONLY_VIOLATION: 'cross_claw_broadcast_motion_only_violation',
  CROSS_CLAW_TOOL_REGISTER_FAILED: 'cross_claw_tool_register_failed',
  BROADCAST_CLAW_SKIPPED: 'broadcast_claw_skipped',
  INVALID_CLAW_DIR: 'invalid_claw_dir',
  CLAW_DIR_NOT_DIRECTORY: 'claw_dir_not_directory',
} as const;
