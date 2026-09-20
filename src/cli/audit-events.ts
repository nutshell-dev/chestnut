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
  CLAW_IMPORT: 'cli_claw_import',                                        // NEW phase 1452: claw import 成功侧
  CLAW_DAEMON_START: 'cli_claw_daemon_start',                            // NEW phase 1452: claw daemon spawn 成功侧（失败侧由 PM PROCESS_SPAWN_FAILED 承载）
  CLAW_OUTBOX_DRAIN_START: 'cli_claw_outbox_drain_start',
  CLAW_OUTBOX_DRAIN_DONE: 'cli_claw_outbox_drain_done',
  CLAW_OUTBOX_DRAIN_RACE_LOST: 'cli_claw_outbox_drain_race_lost',          // NEW phase 1222 α-2: atomic claim loser
  CLAW_OUTBOX_SKIP_START: 'cli_claw_outbox_skip_start',                      // NEW phase 1748: outbox-skip mutation 对称 start 事件
  CLAW_OUTBOX_SKIP_DONE: 'cli_claw_outbox_skip_done',                        // NEW phase 1748: outbox-skip mutation 对称 done 事件
  CONTRACT_CREATE: 'cli_contract_create',
  CONTRACT_CANCEL: 'cli_contract_cancel',                                    // NEW phase 1471: contract cancel CLI
  CONFIG_SAVED: 'cli_config_saved',                                        // NEW phase 1452: config provider 子命令 saveGlobal 成功侧
  INIT_DONE: 'cli_init_done',
  INIT_PROBE_ATTEMPTED: 'cli_init_probe_attempted',
  INIT_PROBE_SUCCEEDED: 'cli_init_probe_succeeded',
  INIT_PROBE_FAILED: 'cli_init_probe_failed',
  INIT_PROBE_RECONFIGURED: 'cli_init_probe_reconfigured',
  INIT_PROBE_SKIPPED: 'cli_init_probe_skipped',
  MOTION_INIT: 'cli_motion_init',
  MOTION_OUTBOX_DRAIN_START: 'cli_motion_outbox_drain_start',
  MOTION_OUTBOX_DRAIN_DONE: 'cli_motion_outbox_drain_done',
  MOTION_STOP: 'cli_motion_stop',
  MOTION_DAEMON_START: 'cli_motion_daemon_start',                          // NEW phase 1452: motion daemon spawn 成功侧（失败侧由 PM 承载）
  SKILL_INSTALL: 'cli_skill_install',
  STREAM_SHUTDOWN_FAILED: 'cli_stream_shutdown_failed',                       // NEW phase 1377: claw stream signal/daemon-dead stop() rejection convergence
  DAEMON_START: 'cli_daemon_start',
  DAEMON_STOP: 'cli_daemon_stop',
  DAEMON_SPAWN_RACE_FAILED: 'cli_daemon_spawn_race_failed',
} as const;
