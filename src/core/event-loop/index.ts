/**
 * @module L5.EventLoop
 * @layer L5 服务层
 * @depends L2.AuditLog, L2.Stream, L2.Messaging, L4.ContextManager, L5.Runtime
 * @consumers L6.Daemon
 *
 * 事件驱动的轮次调度服务。在 daemon（进程生命周期）和 runtime（轮次执行）之间
 * 承担编排职责：消息到达、轮次失败、上下文超限等事件到达后，
 * 决定下一步调度什么动作。
 */

export { EventLoop } from './event-loop.js';
export type { EventLoopOptions, LLMRetryState, LoopErrorContext } from './types.js';
export {
  LLM_MAX_RETRIES,
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_MAX_DELAY_MS,
  LLM_RETRY_STATE_FILE,
} from './constants.js';
export { EVENTLOOP_AUDIT_EVENTS, LOOP_ITERATION_TYPES, LOOP_INTERRUPT_CAUSES } from './audit-events.js';
export { dispatchError, ERROR_HANDLERS } from './error-handlers.js';
export { waitForInbox } from './inbox-watcher.js';
export { createStreamCallbacks } from './stream-callbacks.js';
