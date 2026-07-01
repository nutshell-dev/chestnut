export const EVENTLOOP_AUDIT_EVENTS = {
  /** 轮次消费编排完成 */
  ITERATION: 'eventloop_iteration',
  /** 进入退避重试 */
  LLM_RETRY: 'eventloop_llm_retry',
  /** 退避重试耗尽，进入限流等待 */
  COOLDOWN: 'eventloop_cooldown',
  /** 调度层异常 */
  FATAL: 'eventloop_fatal',
} as const;

export const LOOP_ITERATION_TYPES = {
  CHAIN: 'chain',
  CHAIN_LIMITED: 'chain_limited',
  WAIT: 'wait',
} as const;

export const LOOP_INTERRUPT_CAUSES = {
  IDLE_TIMEOUT: 'idle_timeout',
  USER_INTERRUPT: 'user_interrupt',
  PRIORITY_INBOX: 'priority_inbox',
} as const;
