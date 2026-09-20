/**
 * @module L5.EventLoop
 * @layer L5 服务层
 * @depends L2.AuditLog, L2.Stream, L2.Messaging, L4.ContextManager, L4.Runtime
 * @consumers L6.Daemon
 *
 * 事件驱动的轮次调度服务。在 daemon（进程生命周期）和 runtime（轮次执行）之间
 * 承担编排职责：消息到达、轮次失败、上下文超限等事件到达后，
 * 决定下一步调度什么动作。
 */

export { EventLoop } from './event-loop.js';
export type { EventLoopRuntime, EventLoopTraceSource, EventLoopExecutionRecoveryDeps, TurnStartCallback, EventLoopStreamCallbacks } from './types.js';
export { EVENTLOOP_FILE_ROUTING } from './audit-events.js';
// phase 1869 Step H: 呈现显式装配（execution_recovery rendering declaration）
export { EVENTLOOP_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';
// Phase 1396 Step E: 执行停滞恢复（record store / controller / 持久 activity 事实读取）
export {
  createExecutionRecoveryController,
  createExecutionRecoveryStore,
  readStreamExecutionActivityMs,
  parseExecutionRecoveryRecord,
} from './execution-recovery.js';
export type {
  ExecutionActivitySnapshot,
  ExecutionRecoveryController,
  ExecutionRecoveryDelivery,
  ExecutionRecoveryDeliveryOutcome,
  ExecutionRecoveryDeliveryRequest,
  ExecutionRecoveryRecord,
  ExecutionRecoveryStore,
  PendingExecutionResume,
} from './execution-recovery.js';
