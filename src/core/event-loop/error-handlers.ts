/**
 * @module L5.EventLoop.ErrorHandlers
 * @layer L5 服务层
 * @depends L2.AuditLog, L1.FileSystem, L2.Messaging, L4.Runtime
 * @consumers L5.EventLoop
 *
 * EventLoop catch 块错误分类 handler 注册表。
 * 新增错误类型仅需加 entry、不改 catch 块本身（OCP）。
 */

import { formatErr } from '../../foundation/node-utils/index.js';
import { EVENTLOOP_AUDIT_EVENTS, LOOP_INTERRUPT_CAUSES } from './audit-events.js';
import { INTERRUPT_RECOVERY_DELAY_MS, UNKNOWN_ERROR_RECOVERY_DELAY_MS } from './constants.js';
import type { LoopErrorContext } from './types.js';
import { isStepAbortError, abortEvidenceAuditCols, type StepAbortError, type StepAbortReason } from '../step-executor/index.js';
import {
  MaxStepsExceededError,
  WallTimeExceededError,
  ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError,
} from '../agent-executor/index.js';

/**
 * EventLoop catch 块状态、handler 可读写以驱动恢复决策。
 * Phase 1268 Step B: recoverable LLM 消息级 retry/cooldown 已收敛为
 * EventLoop-owned 持久 waiting 状态机（event-loop.ts），handler 不再
 * 触碰 llmRetry 状态。
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * ErrorHandler — 单一错误类型的处理策略
 * - match: 判该 err 是否本 handler 范畴
 * - handle: 执行 audit + recovery + state 变更
 *
 * 注册表按 match 顺序匹配、首个 match=true 即 handle 后返回
 */
interface ErrorHandler {
  name: string;
  match: (err: unknown, ctx: LoopErrorContext) => boolean;
  handle: (err: unknown, ctx: LoopErrorContext) => Promise<void>;
}

const stepAbortKindIs = (kind: StepAbortReason['kind']) =>
  (err: unknown): err is StepAbortError => isStepAbortError(err) && err.reason.kind === kind;

// ----- 4 handlers（Phase 1268 Step B: llm_retry handler 已退役） -----

const idleTimeoutHandler: ErrorHandler = {
  name: 'idle_timeout',
  // phase 1857 Step B (SE-D1): instanceof 判据改 reason.kind 数据判据
  match: stepAbortKindIs('idle_timeout'),
  handle: async (err, ctx) => {
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `cause=${LOOP_INTERRUPT_CAUSES.idle_timeout}`,
      `recovery_delay_ms=${INTERRUPT_RECOVERY_DELAY_MS}`,
      ...abortEvidenceAuditCols(err),
    );
    await abortableDelay(INTERRUPT_RECOVERY_DELAY_MS, ctx.signal);
  },
};

const userInterruptHandler: ErrorHandler = {
  name: 'user_interrupt',
  match: stepAbortKindIs('user_interrupt'),
  handle: async (err, ctx) => {
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `cause=${LOOP_INTERRUPT_CAUSES.user_interrupt}`,
      ...abortEvidenceAuditCols(err),
    );
    // 不 waitForInbox — 直接返回让 while loop 下一轮立即调 prepareInbox + processTurn，
    // 把被中断 turn 期间到达、仍残留在 inbox/pending 里的消息正常 drain 出来。
    // pending 真空时 prepareInbox 返回空批次自然走正常 waitForInbox。
    // 与 priorityInboxHandler 保持一致。
  },
};

const priorityInboxHandler: ErrorHandler = {
  name: 'priority_inbox',
  match: stepAbortKindIs('step_yield'),
  handle: async (err, ctx) => {
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `cause=${LOOP_INTERRUPT_CAUSES.priority_inbox}`,
      `recovery_delay_ms=0`,
      ...abortEvidenceAuditCols(err),
    );
  },
};

/**
 * P0-2: 5 个确定性 typed Error 的统一 crash 分类源。
 * Phase 1944 Step B: LLMAllProvidersFailedError 等 provider 聚合失败在 failed-turn /
 * post-drain 入口已凭 TurnResult.failureDisposition / getLLMFailureDisposition 的
 * owner typed 事实提前 defer，不再到达本 dispatch；handler 不再重判 provider 身份。
 */
export function isAgentLoopCrashError(err: unknown): boolean {
  return err instanceof MaxStepsExceededError
      || err instanceof WallTimeExceededError
      || err instanceof ConsecutiveParseErrorsExceededError
      || err instanceof ConsecutiveMaxTokensToolUseError;
}

const agentLoopCrashHandler: ErrorHandler = {
  name: 'agent_loop_crash',
  match: (err) => isAgentLoopCrashError(err),
  handle: async (err, ctx) => {
    // Phase 1268 Step B: 不再清零 llmRetry 状态；waiting/预算由 EventLoop
    // waiting 状态机唯一管理，crash 不改变已决定的 recoverable 等待。
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.FATAL,
      `reason=agent_loop_crash`,
      `error=${formatErr(err)}`,
    );
  },
};

const fallbackHandler: ErrorHandler = {
  name: 'fatal_fallback',
  match: () => true,  // 兜底
  handle: async (err, ctx) => {
    // Phase 1944 Step B: provider 聚合失败不再到达本 handler（上游 typed
    // disposition 已 defer）；能到这里的一律是非 provider-recovery 错误，只审计。
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.FATAL,
      `reason=non_llm_error`,
      `recovery_delay_ms=${UNKNOWN_ERROR_RECOVERY_DELAY_MS}`,
      `error=${formatErr(err)}`,
    );
    // Unknown deterministic errors may recur before drain reaches its empty
    // wait path. Bound that residual hot-loop surface without consuming an LLM
    // retry budget; shutdown can interrupt the delay.
    await abortableDelay(UNKNOWN_ERROR_RECOVERY_DELAY_MS, ctx.signal);
  },
};

const ERROR_HANDLERS: ReadonlyArray<ErrorHandler> = [
  idleTimeoutHandler,
  userInterruptHandler,
  priorityInboxHandler,
  agentLoopCrashHandler,
  fallbackHandler,
];

export async function dispatchError(err: unknown, ctx: LoopErrorContext): Promise<void> {
  for (const handler of ERROR_HANDLERS) {
    if (handler.match(err, ctx)) {
      await handler.handle(err, ctx);
      return;
    }
  }
  // 兜底永远 match、不应到这
  throw new Error('Unreachable: fallback handler should match all errors');
}
