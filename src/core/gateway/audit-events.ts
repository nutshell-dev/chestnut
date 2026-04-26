/**
 * Gateway audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts GATEWAY_ 系列等价 / 0 漂移。
 */
export const GATEWAY_AUDIT_EVENTS = {
  STARTED: 'gateway_started',
  STOPPED: 'gateway_stopped',
  ASK_USER_PENDING: 'gateway_ask_user_pending',
  ASK_USER_RESOLVED: 'gateway_ask_user_resolved',
  ASK_USER_CANCELLED: 'gateway_ask_user_cancelled',
  ASK_USER_REPLY_DROPPED: 'gateway_ask_user_reply_dropped',
  CONNECTION_DROPPED: 'gateway_connection_dropped',
  INTERRUPT_TRIGGERED: 'gateway_interrupt_triggered',
  INTERRUPT_DEBOUNCED: 'gateway_interrupt_debounced',
  TRANSPORT_ERROR: 'gateway_transport_error',
} as const;
