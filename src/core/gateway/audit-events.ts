/**
 * Gateway audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts GATEWAY_ 系列等价 / 0 漂移。
 */
export const GATEWAY_AUDIT_EVENTS = {
  STARTED: 'gateway_started',
  STOPPED: 'gateway_stopped',
  STARTUP_FAILED: 'gateway_startup_failed',
  STOP_NOOP: 'gateway_stop_noop',
  STOPPED_WITH_ERRORS: 'gateway_stopped_with_errors',
  CONNECTION_ACCEPTED: 'gateway_connection_accepted',
  CONNECTION_DISCONNECTED: 'gateway_connection_disconnected',
  ASK_USER_PENDING: 'gateway_ask_user_pending',
  ASK_USER_RESOLVED: 'gateway_ask_user_resolved',
  ASK_USER_CANCELLED: 'gateway_ask_user_cancelled',
  ASK_USER_REPLY_DROPPED: 'gateway_ask_user_reply_dropped',
  ASK_USER_RACE_LOSS: 'gateway_ask_user_race_loss',
  ASK_USER_BROADCAST_FAILED: 'gateway_ask_user_broadcast_failed',
  ASK_USER_NO_LISTENER: 'gateway_ask_user_no_listener',
  CONNECTION_DROPPED: 'gateway_connection_dropped',
  INTERRUPT_TRIGGERED: 'gateway_interrupt_triggered',
  INTERRUPT_DEBOUNCED: 'gateway_interrupt_debounced',
  TRANSPORT_ERROR: 'gateway_transport_error',
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const GATEWAY_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  gateway_started: 'audit',
  gateway_stopped: 'audit',
  gateway_startup_failed: 'audit',
  gateway_stop_noop: 'audit',
  gateway_stopped_with_errors: 'audit',
  gateway_connection_accepted: 'audit',
  gateway_connection_disconnected: 'audit',
  gateway_ask_user_pending: 'audit',
  gateway_ask_user_resolved: 'audit',
  gateway_ask_user_cancelled: 'audit',
  gateway_ask_user_reply_dropped: 'audit',
  gateway_ask_user_race_loss: 'audit',
  gateway_ask_user_broadcast_failed: 'audit',
  gateway_ask_user_no_listener: 'audit',
  gateway_connection_dropped: 'audit',
  gateway_interrupt_triggered: 'audit',
  gateway_interrupt_debounced: 'audit',
  gateway_transport_error: 'audit',
} as const;
