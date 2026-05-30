/**
 * CLI command audit events (mutation operations).
 *
 * Per DP 4「外部对系统的操作通过 CLI 唯一入口」+ DP 1+2+5 derive
 * (phase 693 Step C C-1 γ dominant / r93-D phase 698 land).
 *
 * 仅 mutation CLI 加 audit / read-only CLI 不加（per ML 8 耦合界面最小）。
 */
export const CLI_AUDIT_EVENTS = {
  CLAW_CREATE: 'cli_claw_create',
  CLAW_STOP: 'cli_claw_stop',
  CLAW_OUTBOX_DRAIN_START: 'cli_claw_outbox_drain_start',
  CLAW_OUTBOX_DRAIN_DONE: 'cli_claw_outbox_drain_done',
  CLAW_OUTBOX_DRAIN_RACE_LOST: 'cli_claw_outbox_drain_race_lost',          // NEW phase 1222 α-2: atomic claim loser
  CONTRACT_CREATE: 'cli_contract_create',
  CONTRACT_CANCEL: 'cli_contract_cancel',                                    // NEW phase 1471: contract cancel CLI
  CONTRACT_UPDATE: 'cli_contract_update',
  INIT_DONE: 'cli_init_done',
  INIT_PROBE_ATTEMPTED: 'cli_init_probe_attempted',
  INIT_PROBE_SUCCEEDED: 'cli_init_probe_succeeded',
  INIT_PROBE_FAILED: 'cli_init_probe_failed',
  INIT_PROBE_RECONFIGURED: 'cli_init_probe_reconfigured',
  INIT_PROBE_SKIPPED: 'cli_init_probe_skipped',
  MOTION_INIT: 'cli_motion_init',
  MOTION_STOP: 'cli_motion_stop',
  SKILL_INSTALL: 'cli_skill_install',
  DAEMON_START: 'cli_daemon_start',
  DAEMON_STOP: 'cli_daemon_stop',
  CHAT_CRASH_UNCAUGHT: 'cli_chat_crash_uncaught',
  DAEMON_SPAWN_RACE_FAILED: 'cli_daemon_spawn_race_failed',
} as const;
