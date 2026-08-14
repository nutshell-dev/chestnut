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

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { TurnResult } from '../runtime/index.js';
import type { StreamCallbacks } from '../agent-executor/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';
import { STREAM_EVENT_NAMES } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { STATUS_SUBDIR } from '../../foundation/process-manager/index.js';
import {
  INBOX_FALLBACK_TIMEOUT_MS_DEFAULT,
  LLM_COOLDOWN_MS,
  LLM_MAX_RETRIES,
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_MAX_DELAY_MS,
  LLM_RETRY_STATE_FILE,
  LLM_REQUEST_BLOCKED_STATE_FILE,
  LEGACY_CONTEXT_BLOCKED_STATE_FILE,
  REACT_CHAIN_MAX_ITERATIONS,
} from './constants.js';
import { EVENTLOOP_AUDIT_EVENTS, LOOP_ITERATION_TYPES } from './audit-events.js';
import { dispatchError, isAgentLoopCrashError } from './error-handlers.js';
import { createStreamCallbacks } from './stream-callbacks.js';
import { waitForInbox } from './inbox-watcher.js';
import {
  isContextExceededError,
  LLMInvalidRequestError,
  LLMAllProvidersFailedError,
  LLMRateLimitError,
  classifyLLMError,
  getUserActionHint,
} from '../../foundation/llm-orchestrator/index.js';
import type { UserActionHint } from '../../foundation/llm-orchestrator/index.js';
import type { InboxHandle } from '../../foundation/messaging/index.js';
import type { Message } from '../../foundation/llm-provider/index.js';
import { PendingViewError } from '../../foundation/messaging/index.js';
import type { LLMRequestBlockedState, LLMRequestGateDecision, LLMRetryWaitingState, RecoverableLLMErrorClass, EventLoopOptions, EventLoopRuntime } from './types.js';

export class EventLoop {
  private runtime: EventLoopRuntime;
  private clawId: string;
  private audit: AuditLog;
  private loopFs: FileSystem;
  private agentFs: FileSystem;
  private inboxPendingDir: string;
  private fallbackTimeoutMs: number;
  private streamWriter?: StreamWriter;
  private onBatchComplete?: () => Promise<void>;
  private onTurnActivity?: () => void;
  private onBlockedTerminal?: (state: LLMRequestBlockedState) => Promise<void>;
  private rootFs: FileSystem;

  private stopped = false;

  // LLM failure retry state
  private llmRetryCount = 0;
  private llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
  // Phase 1268 Step B: 已决定的 retry/cooldown 等待（决定即落盘，restart 按 resumeAt 恢复）
  private llmRetryWaiting?: LLMRetryWaitingState;

  // Phase 1154 Step E: LLM-request blocked state (generalized from context-only gate)
  private llmRequestBlocked?: LLMRequestBlockedState;
  private waitAbortController?: AbortController;

  constructor(options: EventLoopOptions) {
    this.runtime = options.runtime;
    this.clawId = options.clawId;
    this.audit = options.audit;
    this.loopFs = options.fsFactory(path.join(options.agentDir, '..'));
    this.agentFs = options.fsFactory(options.agentDir);
    this.rootFs = this._resolveRootFs(options.fsFactory, options.agentDir);
    this.inboxPendingDir = options.inbox.pendingDir;
    this.fallbackTimeoutMs = options.inbox.fallbackTimeoutMs ?? INBOX_FALLBACK_TIMEOUT_MS_DEFAULT;
    this.streamWriter = options.streamWriter;
    this.onBatchComplete = options.onBatchComplete;
    this.onTurnActivity = options.onTurnActivity;
    this.onBlockedTerminal = options.onBlockedTerminal;
  }

  /**
   * 启动时恢复：先加载/校验 LLM-request blocked state（事实阻断不随 clean-stop 消失），
   * 再加载 LLM retry state（clean stop 后跳过，保持默认值）。
   */
  async initialize(): Promise<void> {
    this.audit.write(EVENTLOOP_AUDIT_EVENTS.ITERATION, `context=initialize`, `claw_id=${this.clawId}`);
    await this._loadLlmRequestBlockedState();
    const consumeMarker = (fs: FileSystem): boolean => {
      try {
        if (!fs.existsSync('clean-stop')) return false;
        fs.deleteSync('clean-stop');
        return true;
      } catch {
        return false;  // marker 读删失败 best-effort（缺 marker 仅次启动 spurious warn，现状语义保留）
      }
    };
    // P1-11: per-claw marker（<agentDir>/clean-stop）优先，全局 marker（<root>/clean-stop）兜底。
    // 原 loopFs=fsFactory(join(agentDir,'..')) 对 claw 解析到 claws/ 目录，与 marker 实写位置均不匹配。
    const isCleanStop = consumeMarker(this.agentFs)   // per-claw
                     || consumeMarker(this.rootFs);  // global

    if (!isCleanStop) {
      await this._loadLlmRetryState();
    }
  }

  /**
   * 执行一轮事件循环：调用前 gate → 消费 inbox / 重试 / 等待消息。
   *
   * Phase 1154 Step E: 只有 fingerprint 变化或从未 blocked 时才进入 drain+chain；
   * no_progress/policy_conflict/invalid_request 会持久化 blocked state，后续 tick 在 drain 前 fail-closed。
   */
  async run(): Promise<void> {
    this.stopped = false;
    this.waitAbortController = new AbortController();

    try {
      const gate = await this._checkLlmRequestGate();
      if (gate.kind === 'blocked' || gate.kind === 'indeterminate') {
        this.audit.write(
          gate.kind === 'blocked'
            ? EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_GATE
            : EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_PEEK_FAILED,
          `fingerprint=${this.llmRequestBlocked?.requestFingerprint ?? ''}`,
        );
        await waitForInbox(
          this.loopFs,
          this.audit,
          this.inboxPendingDir,
          this.fallbackTimeoutMs,
          this.waitAbortController.signal,
        );
        return;
      }
      if (gate.kind === 'released') {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_RELEASED,
          `old=${gate.previous.requestFingerprint}`,
          `new=${gate.fingerprint}`,
        );
      }

      // Phase 1268 Step B: pre-drain waiting gate — 已决定的 retry/cooldown
      // 等待在 drain 前生效；abort 中断时保留 waiting 供 restart 恢复。
      const waitingDecision = await this._gateOnLlmRetryWaiting(gate.fingerprint);
      if (waitingDecision === 'stopped') return;

      await this._runOpenChain(gate.fingerprint);
    } catch (err) {
      // EventLoop-level unexpected error
      await this._dispatchError(err);
    } finally {
      this.waitAbortController = undefined;
    }
  }

  /**
   * 中断当前 turn。daemon-loop 在 interrupt watcher 触发时调用。
   */
  abort(): void {
    this.stopped = true;
    this.waitAbortController?.abort();
    this.runtime.abort();
  }

  /**
   * phase 1383: 绑定 daemon 进程级活动打点（waiting-stall 自活用）。
   * daemon-loop 构造 EventLoop 后注入，避免 EventLoop 感知 daemon 层 monitor。
   */
  setOnTurnActivity(cb: (() => void) | undefined): void {
    this.onTurnActivity = cb;
  }

  /**
   * phase 1390 Step B: 绑定 blocked 终局 fail-fast callback（daemon-loop 装配时注入）。
   * 与 setOnTurnActivity 同源——EventLoop 在 daemon.ts 构造、daemon-loop 持有 contractManager，
   * 故 setter 注入而非构造选项。传 undefined 清除（测试/旧路径）。
   */
  setOnBlockedTerminal(cb: ((state: LLMRequestBlockedState) => Promise<void>) | undefined): void {
    this.onBlockedTerminal = cb;
  }

  /**
   * phase 1387 Step B: 只读在途状态查询面（waiting-stall skip 判定用）。
   * 「系统在途」= LLM retry/cooldown waiting 已决定且未释放、或 LLM request 处于 blocked 态——
   * 二者任一在途即视为 EventLoop 正按既定调度推进、不应判 spontaneous stall。
   * 只暴露 boolean，不复制内部状态逻辑（M#8 最小面）。
   */
  isBusy(): boolean {
    return this.llmRetryWaiting !== undefined || this.llmRequestBlocked !== undefined;
  }

  private async _handleFailedTurn(
    result: TurnResult,
    addressedHandles: InboxHandle[],
    failedRequestFingerprint: string,
  ): Promise<void> {
    if (result.status !== 'failed') return;
    if (isAgentLoopCrashError(result.error)) {
      // phase 1121 Step B: process failure 不再 mutate Contract；直接 ack 破热循环，
      // 错误调度 / fatal audit 由 _dispatchError 负责。
      await this.runtime.ackHandles(addressedHandles, 'agent_loop_crash');
    } else {
      await this.runtime.nackHandles(addressedHandles, formatErr(result.error), 'rollback');
    }
    if (isContextExceededError(result.error)) {
      await this._handleContextExceeded(result.error, failedRequestFingerprint);
      return;
    }
    if (this._isDeterministicPermanentError(result.error)) {
      this._enterLlmRequestBlocked(
        this._isInvalidRequestError(result.error)
          ? {
              version: 2,
              reason: 'invalid_request',
              requestFingerprint: failedRequestFingerprint,
              errorCode: 'LLM_INVALID_REQUEST',
              blockedAt: new Date().toISOString(),
            }
          : {
              version: 2,
              reason: 'permanent_provider_error',
              requestFingerprint: failedRequestFingerprint,
              userActionHint: this._resolvePermanentErrorHint(result.error),
              message: formatErr(result.error),
              blockedAt: new Date().toISOString(),
            },
      );
      this._resetLlmRetryState();
      this._saveLlmRetryState();
      return;
    }
    const errorClass = classifyLLMError(result.error);
    if (errorClass === 'transient' || errorClass === 'rate_limit') {
      // Phase 1268 Step B: recoverable LLM 失败由 EventLoop-owned 持久
      // waiting 状态机调度，不再经由通用 fallback handler 清零重放。
      await this._scheduleRecoverableLlmWait(result.error, errorClass, failedRequestFingerprint);
      return;
    }
    await this._dispatchError(result.error);
  }

  /**
   * Phase 1268 Step B: recoverable LLM 失败的消息级调度。
   * - count<max：计算 delay/deadline → 设置 waiting → atomic save（先落盘）→
   *   audit scheduled。等待本身发生在下一次 run() 的 pre-drain gate。
   * - count>=max：进入固定 cooldown，count 保持 max 不 reset；到期只允许一次 probe。
   */
  private async _scheduleRecoverableLlmWait(
    error: unknown,
    errorClass: RecoverableLLMErrorClass,
    requestFingerprint: string,
  ): Promise<void> {
    const nowMs = Date.now();
    const scheduledAt = new Date(nowMs).toISOString();
    const errorText = formatErr(error);

    if (this.llmRetryCount < LLM_MAX_RETRIES) {
      this.llmRetryCount++;
      const delayMs = errorClass === 'rate_limit'
        ? this._resolveRateLimitRetryDelayMs(error)
        : this.llmRetryDelayMs;
      const resumeAt = new Date(nowMs + delayMs).toISOString();
      const waiting: LLMRetryWaitingState = {
        kind: 'retry',
        requestFingerprint,
        errorClass,
        attempt: this.llmRetryCount,
        maxAttempts: LLM_MAX_RETRIES,
        scheduledAt,
        resumeAt,
        error: errorText,
      };
      this.llmRetryWaiting = waiting;
      this._saveLlmRetryState();
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.LLM_RETRY,
        `action=scheduled`,
        `attempt=${this.llmRetryCount}`,
        `max=${LLM_MAX_RETRIES}`,
        `delay_ms=${delayMs}`,
        `resume_at=${resumeAt}`,
        `fingerprint=${requestFingerprint}`,
        `error_class=${errorClass}`,
        `error=${errorText}`,
      );
      this._writeLlmRetryWaitingStream(waiting, 'scheduled', delayMs);
      return;
    }

    const cooldownMs = this._resolveCooldownMs(error);
    const resumeAt = new Date(nowMs + cooldownMs).toISOString();
    const cooldownWaiting: LLMRetryWaitingState = {
      kind: 'cooldown',
      requestFingerprint,
      errorClass,
      attempts: this.llmRetryCount,
      maxAttempts: LLM_MAX_RETRIES,
      scheduledAt,
      resumeAt,
      error: errorText,
    };
    this.llmRetryWaiting = cooldownWaiting;
    this._saveLlmRetryState();
    this.audit.write(
      EVENTLOOP_AUDIT_EVENTS.COOLDOWN,
      `action=scheduled`,
      `attempts=${this.llmRetryCount}`,
      `max=${LLM_MAX_RETRIES}`,
      `cooldown_ms=${cooldownMs}`,
      `resume_at=${resumeAt}`,
      `fingerprint=${requestFingerprint}`,
      `error_class=${errorClass}`,
      `error=${errorText}`,
    );
    this._writeLlmRetryWaitingStream(cooldownWaiting, 'scheduled', cooldownMs);
  }

  /**
   * Phase 1268 Step D: waiting 状态写结构化 stream（presentation 实时渲染用）。
   * stream 写失败不阻断调度（fail-observable audit）。
   */
  private _writeLlmRetryWaitingStream(
    waiting: LLMRetryWaitingState,
    action: 'scheduled' | 'gated' | 'released',
    delayMs: number,
  ): void {
    if (!this.streamWriter) return;
    try {
      this.streamWriter.write({
        ts: Date.now(),
        type: STREAM_EVENT_NAMES.LLM_RETRY_WAITING,
        stage: waiting.kind,
        action,
        attempt: waiting.kind === 'retry' ? waiting.attempt : waiting.attempts,
        maxAttempts: waiting.maxAttempts,
        delayMs,
        resumeAt: waiting.resumeAt,
        errorClass: waiting.errorClass,
      });
    } catch (error) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=writeLlmRetryWaitingStream`,
        `reason=${formatErr(error)}`,
      );
    }
  }

  /**
   * Phase 1268 Step B: pre-drain waiting gate。
   * - 无 waiting → proceed。
   * - fingerprint 变化 → released：清 waiting 并 reset 预算，按新事实执行。
   * - fingerprint 相同且 deadline 未到 → 等 deadline/新 inbox（可中断）；
   *   abort 时保留 waiting 返回 'stopped'。
   * - deadline 到期：retry → 清 waiting、delay 翻倍并保存；cooldown → 清 waiting
   *   但 count 保持 max，本 tick 仅放一次 probe（probe 失败会再次 cooldown）。
   */
  private async _gateOnLlmRetryWaiting(entryFingerprint: string): Promise<'proceed' | 'stopped'> {
    const waiting = this.llmRetryWaiting;
    if (!waiting) return 'proceed';

    const eventName = waiting.kind === 'retry'
      ? EVENTLOOP_AUDIT_EVENTS.LLM_RETRY
      : EVENTLOOP_AUDIT_EVENTS.COOLDOWN;

    let fingerprint = entryFingerprint;
    if (fingerprint !== waiting.requestFingerprint) {
      this._releaseLlmRetryWaiting(waiting, fingerprint);
      return 'proceed';
    }

    while (!this.stopped) {
      const remainingMs = Date.parse(waiting.resumeAt) - Date.now();
      if (remainingMs <= 0) break;
      this.audit.write(
        eventName,
        `action=gated`,
        `resume_at=${waiting.resumeAt}`,
        `remaining_ms=${remainingMs}`,
        `fingerprint=${waiting.requestFingerprint}`,
      );
      this._writeLlmRetryWaitingStream(waiting, 'gated', remainingMs);
      // 等 deadline 或新 inbox 文件（新消息可能改变 fingerprint 提前释放）。
      await Promise.race([
        this._sleep(remainingMs, this.waitAbortController?.signal),
        waitForInbox(
          this.loopFs,
          this.audit,
          this.inboxPendingDir,
          remainingMs,
          this.waitAbortController?.signal,
        ),
      ]);
      if (this.stopped) return 'stopped';
      try {
        fingerprint = await this.runtime.computeTurnRequestFingerprint();
      } catch (error) {
        if (error instanceof PendingViewError) {
          this.audit.write(
            eventName,
            `action=gated`,
            `reason=fingerprint_indeterminate`,
            `fingerprint=${waiting.requestFingerprint}`,
          );
          await waitForInbox(
            this.loopFs,
            this.audit,
            this.inboxPendingDir,
            this.fallbackTimeoutMs,
            this.waitAbortController?.signal,
          );
          return 'stopped';
        }
        throw error;
      }
      if (fingerprint !== waiting.requestFingerprint) {
        this._releaseLlmRetryWaiting(waiting, fingerprint);
        return 'proceed';
      }
    }
    if (this.stopped) return 'stopped';

    // deadline 到期
    this.llmRetryWaiting = undefined;
    if (waiting.kind === 'retry') {
      this.llmRetryDelayMs = Math.min(this.llmRetryDelayMs * 2, LLM_RETRY_MAX_DELAY_MS);
    }
    // cooldown：count 保持 max，probe 语义由下一次失败重新进入 cooldown 保证。
    this._saveLlmRetryState();
    return 'proceed';
  }

  /** Phase 1268 Step B: fingerprint 变化释放 waiting 并重置 retry 预算。 */
  private _releaseLlmRetryWaiting(waiting: LLMRetryWaitingState, newFingerprint: string): void {
    const eventName = waiting.kind === 'retry'
      ? EVENTLOOP_AUDIT_EVENTS.LLM_RETRY
      : EVENTLOOP_AUDIT_EVENTS.COOLDOWN;
    this.llmRetryWaiting = undefined;
    this._resetLlmRetryState();
    this._saveLlmRetryState();
    this.audit.write(
      eventName,
      `action=released`,
      `old=${waiting.requestFingerprint}`,
      `new=${newFingerprint}`,
    );
    this._writeLlmRetryWaitingStream(waiting, 'released', 0);
  }

  /**
   * Phase 1268 Step B: 从 typed Error 提取最早合法 Retry-After（秒）。
   * 聚合错误选择“任一可用 provider 的最早合法时间”；无 header 返回 undefined。
   * 禁止凭 error message 正则推导。
   */
  private _extractMinRetryAfterSec(error: unknown): number | undefined {
    let minRetryAfterSec: number | undefined;
    if (error instanceof LLMRateLimitError && error.retryAfter !== undefined) {
      minRetryAfterSec = error.retryAfter;
    } else if (error instanceof LLMAllProvidersFailedError) {
      for (const f of error.failures) {
        if (f.error instanceof LLMRateLimitError && f.error.retryAfter !== undefined) {
          if (minRetryAfterSec === undefined || f.error.retryAfter < minRetryAfterSec) {
            minRetryAfterSec = f.error.retryAfter;
          }
        }
      }
    }
    return minRetryAfterSec;
  }

  /** 普通 retry 退避：有 Retry-After 按其取值（沿用既有 backoff cap 语义），否则用当前 delayMs。 */
  private _resolveRateLimitRetryDelayMs(error: unknown): number {
    const retryAfterSec = this._extractMinRetryAfterSec(error);
    if (retryAfterSec !== undefined) {
      return Math.min(retryAfterSec * 1000, LLM_RETRY_MAX_DELAY_MS);
    }
    return this.llmRetryDelayMs;
  }

  /**
   * Phase 1268 Step B: cooldown 至少为独立默认 cooldown；服务端给更长
   * Retry-After 时不得用 LLM_RETRY_MAX_DELAY_MS cap 截短。
   */
  private _resolveCooldownMs(error: unknown): number {
    const retryAfterSec = this._extractMinRetryAfterSec(error);
    if (retryAfterSec !== undefined) {
      return Math.max(LLM_COOLDOWN_MS, retryAfterSec * 1000);
    }
    return LLM_COOLDOWN_MS;
  }

  /**
   * Phase 1163: generalized from invalid-request-only detection. Any error
   * classifyLLMError() reports as 'permanent' (auth, model-not-found,
   * invalid-request, quota-pattern-matched) is deterministic — retrying it
   * without a config change cannot succeed, so it must enter the blocked
   * gate instead of looping through fallbackHandler indefinitely.
   */
  private _isDeterministicPermanentError(error: unknown): boolean {
    return classifyLLMError(error) === 'permanent';
  }

  /**
   * Phase 1154 Step E: keep the 'invalid_request' reason precise.
   * Only true invalid-request errors (or all-provider failures whose every nested
   * failure is an invalid request) use the existing 'invalid_request' reason.
   */
  private _isInvalidRequestError(error: unknown): boolean {
    if (error instanceof LLMInvalidRequestError) return true;
    return (
      error instanceof LLMAllProvidersFailedError
      && error.failures.length > 0
      && error.failures.every(f => f.error instanceof LLMInvalidRequestError)
    );
  }

  private _resolvePermanentErrorHint(error: unknown): UserActionHint {
    if (error instanceof LLMAllProvidersFailedError) {
      for (const failure of error.failures) {
        const hint = getUserActionHint(failure.error);
        if (hint) return hint;
      }
      return null;
    }
    return getUserActionHint(error);
  }

  /**
   * Phase 1153 Step D: route reactive trim outcome with bounded retry.
   * - If retry budget already exhausted, block the current failed request before another trim.
   * - target_reached/progress (and actually persisted) → bounded retry with backoff.
   * - no_progress/policy_conflict → blocked state; retry state reset; no cooldown loop.
   */
  private async _handleContextExceeded(
    error: unknown,
    failedRequestFingerprint: string,
  ): Promise<void> {
    if (this.llmRetryCount >= LLM_MAX_RETRIES) {
      this._enterLlmRequestBlocked({
        version: 2,
        reason: 'retry_exhausted',
        requestFingerprint: failedRequestFingerprint,
        attempts: this.llmRetryCount,
        maxAttempts: LLM_MAX_RETRIES,
        blockedAt: new Date().toISOString(),
      });
      this._resetLlmRetryState();
      this._saveLlmRetryState();
      return;
    }

    const outcome = await this.runtime.reactiveTrim();
    switch (outcome.status) {
      case 'target_reached':
      case 'progress':
        if (!outcome.archived || outcome.after >= outcome.before) {
          throw new Error(`invalid persisted trim outcome: ${outcome.status}`);
        }
        await this._scheduleLlmRetry(error);
        return;
      case 'no_progress':
      case 'policy_conflict':
        this._enterLlmRequestBlocked({
          version: 2,
          reason: outcome.status,
          requestFingerprint: failedRequestFingerprint,
          before: outcome.before,
          after: outcome.after,
          blockedAt: new Date().toISOString(),
        });
        this._resetLlmRetryState();
        this._saveLlmRetryState();
        return;
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unhandled trim outcome: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async _scheduleLlmRetry(error: unknown): Promise<void> {
    this.llmRetryCount++;
    this.audit.write(
      EVENTLOOP_AUDIT_EVENTS.LLM_RETRY,
      `attempt=${this.llmRetryCount}`,
      `max=${LLM_MAX_RETRIES}`,
      `delay_ms=${this.llmRetryDelayMs}`,
      `error=${(error as Error).message}`,
    );
    await this._sleep(this.llmRetryDelayMs, this.waitAbortController?.signal);
    this.llmRetryDelayMs = Math.min(this.llmRetryDelayMs * 2, LLM_RETRY_MAX_DELAY_MS);
    this._saveLlmRetryState();
  }

  private _sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
   * Phase 1153 Step C: pre-drain gate.
   * - No blocked state → open with current fingerprint.
   * - Blocked fingerprint unchanged → blocked (fail-closed, wait for inbox).
   * - Blocked fingerprint changed → released (clear state, proceed once).
   * - Peek failure → indeterminate (fail-closed, wait for inbox).
   */
  private async _checkLlmRequestGate(): Promise<LLMRequestGateDecision> {
    if (!this.llmRequestBlocked) {
      return { kind: 'open', fingerprint: await this.runtime.computeTurnRequestFingerprint() };
    }
    try {
      const fingerprint = await this.runtime.computeTurnRequestFingerprint();
      if (fingerprint === this.llmRequestBlocked.requestFingerprint) {
        return { kind: 'blocked', state: this.llmRequestBlocked };
      }
      const previous = this._clearLlmRequestBlockedState();
      return { kind: 'released', previous, fingerprint };
    } catch (error) {
      if (error instanceof PendingViewError) {
        return { kind: 'indeterminate', error };
      }
      throw error;
    }
  }

  /**
   * Phase 1158 Step C: drain 后单批处理的 disposition guard。
   * 从 handles 取得到 ack/nack 完成之间，任何 unexpected error 均选择一次 nack
   * 并记录 recovery audit，再进入既有错误调度。
   */
  private async _processDrainedBatch(args: {
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
    addressedHandles: InboxHandle[];
    turnFingerprint: string;
    wrappedCallbacks?: StreamCallbacks;
  }): Promise<'continue' | 'break'> {
    type PostDrainStage =
      | 'system_prompt'
      | 'session_messages'
      | 'proactive_trim'
      | 'turn_start_callback'
      | 'process_turn'
      | 'turn_result';

    let dispositionSelected = false;
    let stage: PostDrainStage = 'system_prompt';
    try {
      const systemPrompt = await this.runtime.getSystemPrompt();
      const tools = this.runtime.getToolsForLLM();
      stage = 'session_messages';
      const sessionMessages = await this.runtime.getMessages();
      stage = 'proactive_trim';
      const messages = await this.runtime.proactiveTrimIfNeeded(
        [...sessionMessages, ...args.injected], systemPrompt, tools,
      );
      stage = 'turn_start_callback';
      args.wrappedCallbacks?.onTurnStart?.(args.sources);
      stage = 'process_turn';
      const result = await this.runtime.processTurn(messages, systemPrompt, tools, args.wrappedCallbacks);
      stage = 'turn_result';

      if (result.status === 'success') {
        dispositionSelected = true;
        await this.runtime.ackHandles(args.addressedHandles, 'normal_turn_end');
        this._resetLlmRetryState();
        this._saveLlmRetryState();
        return 'continue';
      }
      if (result.status === 'interrupted') {
        dispositionSelected = true;
        if (result.cause === 'idle_timeout') {
          await this.runtime.nackHandles(args.addressedHandles, result.cause, 'graceful_interrupt');
        } else {
          await this.runtime.ackHandles(args.addressedHandles, 'graceful_interrupt');
        }
        return 'break';
      }
      dispositionSelected = true;
      await this._handleFailedTurn(result, args.addressedHandles, args.turnFingerprint);
      return 'break';
    } catch (error) {
      if (!dispositionSelected) {
        dispositionSelected = true;
        await this.runtime.nackHandles(
          args.addressedHandles,
          formatErr(error),
          'post_drain_failure',
        );
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED,
          `stage=${stage}`,
          `handles=${args.addressedHandles.length}`,
          `error=${formatErr(error)}`,
        );
      }
      const postDrainErrorClass = classifyLLMError(error);
      if (postDrainErrorClass === 'transient' || postDrainErrorClass === 'rate_limit') {
        // Phase 1268 Step B: reject 路径的 recoverable LLM 错误同样进入持久 waiting，
        // 保持旧 llmRetryHandler 对 throw 路径的重试语义。
        await this._scheduleRecoverableLlmWait(error, postDrainErrorClass, args.turnFingerprint);
      } else {
        await this._dispatchError(error);
      }
      return 'break';
    }
  }

  /**
   * Phase 1153 Step C: open-chain execution with per-iteration gate.
   * Each chain iteration recomputes the gate and binds the fingerprint to that
   * turn's failure handling; the run-entry fingerprint is never reused across turns.
   *
   * Phase 1158 Step C: post-drain pipeline 移入 _processDrainedBatch，由 disposition
   * flag 保证任何 unexpected error 只选择一次 ack/nack。
   */
  private async _runOpenChain(entryFingerprint: string): Promise<void> {
    const wrappedCallbacks = this.streamWriter
      ? createStreamCallbacks(this.streamWriter, this.runtime)
      : undefined;

    let chainIters = 0;
    let chainTotal = 0;
    let firstInjected = 0;
    let turnFingerprint = entryFingerprint;

    while (!this.stopped) {
      if (chainIters > 0) {
        const gate = await this._checkLlmRequestGate();
        if (gate.kind === 'blocked' || gate.kind === 'indeterminate') {
          this.audit.write(
            gate.kind === 'blocked'
              ? EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_GATE
              : EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_PEEK_FAILED,
            `fingerprint=${this.llmRequestBlocked?.requestFingerprint ?? ''}`,
          );
          await waitForInbox(
            this.loopFs,
            this.audit,
            this.inboxPendingDir,
            this.fallbackTimeoutMs,
            this.waitAbortController?.signal,
          );
          return;
        }
        if (gate.kind === 'released') {
          this.audit.write(
            EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_RELEASED,
            `old=${gate.previous.requestFingerprint}`,
            `new=${gate.fingerprint}`,
          );
        }
        turnFingerprint = gate.fingerprint;
      }

      const { injected, sources, count, addressedHandles } = await this.runtime.drainInbox();
      if (count === 0) break;

      if (chainIters === 0) {
        firstInjected = count;
      }
      chainTotal += count;
      chainIters++;

      const action = await this._processDrainedBatch({
        injected,
        sources,
        addressedHandles,
        turnFingerprint,
        wrappedCallbacks,
      });
      this.onTurnActivity?.();
      if (action === 'break') break;

      if (chainIters >= REACT_CHAIN_MAX_ITERATIONS) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.ITERATION,
          `type=${LOOP_ITERATION_TYPES.chain_limited}`,
          `injected=${firstInjected}`,
          `chain_total=${chainTotal}`,
        );
        break;
      }
    }

    if (chainIters > 0) {
      if (chainIters < REACT_CHAIN_MAX_ITERATIONS) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.ITERATION,
          `type=${LOOP_ITERATION_TYPES.chain}`,
          `injected=${firstInjected}`,
          `chain_total=${chainTotal}`,
        );
      }
      await this.onBatchComplete?.();
    } else {
      await waitForInbox(
        this.loopFs,
        this.audit,
        this.inboxPendingDir,
        this.fallbackTimeoutMs,
        this.waitAbortController?.signal,
      );
    }
  }

  private async _dispatchError(err: unknown): Promise<void> {
    await dispatchError(err, {
      audit: this.audit,
      signal: this.waitAbortController?.signal,
    });
  }

  private _resetLlmRetryState(): void {
    this.llmRetryCount = 0;
    this.llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
    this.llmRetryWaiting = undefined;
  }

  private _saveLlmRetryState(): void {
    try {
      this.agentFs.ensureDirSync(STATUS_SUBDIR);
      this.agentFs.writeAtomicSync(
        path.join(STATUS_SUBDIR, LLM_RETRY_STATE_FILE),
        JSON.stringify({
          // Phase 1268 Step B: schema v2 — 保留 count/delayMs，新增 waiting。
          schema_version: 2,
          llmRetryCount: this.llmRetryCount,
          llmRetryDelayMs: this.llmRetryDelayMs,
          // P1-10: pending 字段已废弃，恒 false 保持 schema 兼容。
          llmRetryPending: false,
          waiting: this.llmRetryWaiting ?? null,
        }),
      );
    } catch (e) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=saveLlmRetryState`,
        `reason=${(e as Error).message}`,
      );
    }
  }

  private async _loadLlmRetryState(): Promise<void> {
    let raw: string | undefined;
    try {
      raw = this.agentFs.readSync(path.join(STATUS_SUBDIR, LLM_RETRY_STATE_FILE));
    } catch (e) {
      if (!isFileNotFound(e)) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=loadLlmRetryState`,
          `reason=read_failed`,
          `error=${formatErr(e)}`,
        );
      }
      raw = undefined;
    }

    if (raw === undefined) return;

    let saved: unknown;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=parse_failed`,
        `error=${formatErr(e)}`,
      );
      return;
    }

    if (typeof saved !== 'object' || saved === null) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=schema_invalid`,
        `actual=${typeof saved}`,
      );
      return;
    }

    const s = saved as Record<string, unknown>;
    if (s.schema_version !== 1 && s.schema_version !== 2) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=schema_version_mismatch`,
        `actual=${String(s.schema_version)}`,
        `expected=2`,
      );
      return;
    }

    if (
      typeof s.llmRetryCount !== 'number' ||
      typeof s.llmRetryDelayMs !== 'number' ||
      typeof s.llmRetryPending !== 'boolean'
    ) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=field_type_mismatch`,
      );
      return;
    }

    // Phase 1268 Step B: schema v2 新增 waiting 字段（判别联合），必须为 null 或合法。
    if (s.schema_version === 2 && s.waiting !== null && !this._isValidLlmRetryWaitingState(s.waiting)) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=field_type_mismatch`,
        `field=waiting`,
      );
      return;
    }

    this.llmRetryCount = s.llmRetryCount;
    this.llmRetryDelayMs = s.llmRetryDelayMs;
    // Phase 1268 Step B: v1 读取迁移 count/delay，waiting 恒 null；v2 恢复已决定的等待。
    this.llmRetryWaiting = s.schema_version === 2
      ? (s.waiting as LLMRetryWaitingState | null) ?? undefined
      : undefined;
    // P1-10: 旧文件 pending=true 不再恢复，消息已经 inflight reconcile 重投。
    // 仅审计记录后忽略，避免重复重放。
    if (s.llmRetryPending === true) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.ITERATION,
        `context=loadLlmRetryState`,
        `reason=legacy_pending_ignored`,
      );
    }
  }

  /** Phase 1268 Step B: waiting 判别联合校验；非法/猜测字段一律拒绝。 */
  private _isValidLlmRetryWaitingState(waiting: unknown): waiting is LLMRetryWaitingState {
    if (typeof waiting !== 'object' || waiting === null) return false;
    const w = waiting as Record<string, unknown>;
    if (w.kind !== 'retry' && w.kind !== 'cooldown') return false;
    if (typeof w.requestFingerprint !== 'string' || w.requestFingerprint.length === 0) return false;
    if (w.errorClass !== 'transient' && w.errorClass !== 'rate_limit') return false;
    if (typeof w.scheduledAt !== 'string' || typeof w.resumeAt !== 'string') return false;
    if (typeof w.error !== 'string') return false;
    if (typeof w.maxAttempts !== 'number') return false;
    if (w.kind === 'retry') {
      return typeof w.attempt === 'number';
    }
    return typeof w.attempts === 'number';
  }

  /**
   * Phase 1154 Step E: load and validate LLM-request blocked state.
   * - Prefer v2 file (`llm-request-blocked-state.json`).
   * - Fall back to legacy v1 file (`context-blocked-state.json`) and migrate in-memory
   *   + atomically write v2 + delete legacy.
   * Invalid schema/version/reason/fingerprint → audit fatal and fail-closed (throw).
   */
  private async _loadLlmRequestBlockedState(): Promise<void> {
    let source: 'v2' | 'legacy' | undefined;
    let raw: string | undefined;

    // 1. Try v2 file.
    try {
      raw = this.agentFs.readSync(path.join(STATUS_SUBDIR, LLM_REQUEST_BLOCKED_STATE_FILE));
      source = 'v2';
    } catch (e) {
      if (!isFileNotFound(e)) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=loadLlmRequestBlockedState`,
          `reason=read_failed`,
          `file=v2`,
          `error=${formatErr(e)}`,
        );
        throw new Error(`Failed to load LLM request blocked state: ${formatErr(e)}`);
      }
      raw = undefined;
    }

    // 2. Try legacy v1 file.
    if (raw === undefined) {
      try {
        raw = this.agentFs.readSync(path.join(STATUS_SUBDIR, LEGACY_CONTEXT_BLOCKED_STATE_FILE));
        source = 'legacy';
      } catch (e) {
        if (!isFileNotFound(e)) {
          this.audit.write(
            EVENTLOOP_AUDIT_EVENTS.FATAL,
            `context=loadLlmRequestBlockedState`,
            `reason=read_failed`,
            `file=legacy`,
            `error=${formatErr(e)}`,
          );
          throw new Error(`Failed to load legacy context blocked state: ${formatErr(e)}`);
        }
        raw = undefined;
      }
    }

    if (raw === undefined) return;

    let saved: unknown;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRequestBlockedState`,
        `reason=parse_failed`,
        `file=${source}`,
        `error=${formatErr(e)}`,
      );
      throw new Error(`Failed to parse LLM request blocked state: ${formatErr(e)}`);
    }

    if (source === 'legacy') {
      if (!this._isValidLegacyContextBlockedState(saved)) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=loadLlmRequestBlockedState`,
          `reason=schema_invalid`,
          `file=legacy`,
          `actual=${JSON.stringify(saved)}`,
        );
        throw new Error('Invalid legacy context blocked state schema');
      }
      saved = this._migrateLegacyContextBlockedState(saved);
      // Atomic migration: write v2 before deleting legacy. If write fails we throw
      // and keep legacy intact. If delete fails (non-ENOENT) we still fail-closed
      // because the in-memory gate is now authoritative and the v2 file exists.
      this.agentFs.ensureDirSync(STATUS_SUBDIR);
      this.agentFs.writeAtomicSync(
        path.join(STATUS_SUBDIR, LLM_REQUEST_BLOCKED_STATE_FILE),
        JSON.stringify(saved),
      );
      try {
        this.agentFs.deleteSync(path.join(STATUS_SUBDIR, LEGACY_CONTEXT_BLOCKED_STATE_FILE));
      } catch (error) {
        if (!isFileNotFound(error)) {
          this.audit.write(
            EVENTLOOP_AUDIT_EVENTS.FATAL,
            `context=migrateLlmRequestBlockedState`,
            `reason=legacy_delete_failed`,
            `error=${formatErr(error)}`,
          );
          throw new Error(`Failed to delete legacy context blocked state: ${formatErr(error)}`);
        }
      }
    }

    if (!this._isValidLlmRequestBlockedState(saved)) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRequestBlockedState`,
        `reason=schema_invalid`,
        `file=${source ?? 'v2'}`,
        `actual=${JSON.stringify(saved)}`,
      );
      throw new Error('Invalid LLM request blocked state schema');
    }

    this.llmRequestBlocked = saved;
    this._resetLlmRetryState();
    this._saveLlmRetryState();
  }

  private _isValidLlmRequestBlockedState(saved: unknown): saved is LLMRequestBlockedState {
    if (typeof saved !== 'object' || saved === null) return false;
    const s = saved as Record<string, unknown>;
    if (s.version !== 2) return false;
    if (typeof s.requestFingerprint !== 'string' || s.requestFingerprint.length === 0) return false;
    if (typeof s.blockedAt !== 'string') return false;

    if (s.reason === 'no_progress' || s.reason === 'policy_conflict') {
      if (typeof s.before !== 'number' || typeof s.after !== 'number') return false;
      return true;
    }

    if (s.reason === 'retry_exhausted') {
      if (typeof s.attempts !== 'number' || typeof s.maxAttempts !== 'number') return false;
      return true;
    }

    if (s.reason === 'invalid_request') {
      if (s.errorCode !== 'LLM_INVALID_REQUEST') return false;
      return true;
    }

    if (s.reason === 'permanent_provider_error') {
      if (typeof s.message !== 'string') return false;
      // userActionHint is nullable; presence alone is enough.
      return true;
    }

    return false;
  }

  private _isValidLegacyContextBlockedState(saved: unknown): saved is {
    version: 1;
    reason: 'no_progress' | 'policy_conflict' | 'retry_exhausted';
    requestFingerprint: string;
    blockedAt: string;
    before?: number;
    after?: number;
    attempts?: number;
    maxAttempts?: number;
  } {
    if (typeof saved !== 'object' || saved === null) return false;
    const s = saved as Record<string, unknown>;
    if (s.version !== 1) return false;
    if (typeof s.requestFingerprint !== 'string' || s.requestFingerprint.length === 0) return false;
    if (typeof s.blockedAt !== 'string') return false;

    if (s.reason === 'no_progress' || s.reason === 'policy_conflict') {
      if (typeof s.before !== 'number' || typeof s.after !== 'number') return false;
      return true;
    }

    if (s.reason === 'retry_exhausted') {
      if (typeof s.attempts !== 'number' || typeof s.maxAttempts !== 'number') return false;
      return true;
    }

    return false;
  }

  private _migrateLegacyContextBlockedState(
    legacy: {
      version: 1;
      reason: 'no_progress' | 'policy_conflict' | 'retry_exhausted';
      requestFingerprint: string;
      blockedAt: string;
      before?: number;
      after?: number;
      attempts?: number;
      maxAttempts?: number;
    },
  ): LLMRequestBlockedState {
    const base = {
      version: 2 as const,
      requestFingerprint: legacy.requestFingerprint,
      blockedAt: legacy.blockedAt,
    };
    if (legacy.reason === 'no_progress' || legacy.reason === 'policy_conflict') {
      return { ...base, reason: legacy.reason, before: legacy.before ?? 0, after: legacy.after ?? 0 };
    }
    return {
      ...base,
      reason: 'retry_exhausted',
      attempts: legacy.attempts ?? 0,
      maxAttempts: legacy.maxAttempts ?? LLM_MAX_RETRIES,
    };
  }

  /**
   * Phase 1154 Step E: enter LLM-request blocked state atomically.
   * Memory is set first (fail-closed for current process), then persisted.
   * Only emit CONTEXT_BLOCKED after atomic write succeeds; otherwise keep the
   * in-memory gate and throw so the caller cannot report success.
   */
  private _enterLlmRequestBlocked(state: LLMRequestBlockedState): void {
    this.llmRequestBlocked = state;
    try {
      this.agentFs.ensureDirSync(STATUS_SUBDIR);
      this.agentFs.writeAtomicSync(
        path.join(STATUS_SUBDIR, LLM_REQUEST_BLOCKED_STATE_FILE),
        JSON.stringify(state),
      );
    } catch (error) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=saveLlmRequestBlockedState`,
        `reason=${formatErr(error)}`,
      );
      throw error;
    }
    this.audit.write(
      EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED,
      `reason=${state.reason}`,
      `fingerprint=${state.requestFingerprint}`,
    );
    this._notifyBlockedTerminal(state);
  }

  /**
   * phase 1390 Step B: blocked 终局进入后 fire-and-forget 通知装配方判失败。
   * EventLoop 只负责触发 + 留痕 callback 错误；重试 / 是否 cancel 由装配方决定。
   * 不 await：gate 语义已落盘，不能因 callback 慢/错阻塞 caller 的状态机推进。
   */
  private _notifyBlockedTerminal(state: LLMRequestBlockedState): void {
    if (!this.onBlockedTerminal) return;
    void this.onBlockedTerminal(state).catch((err: unknown) => {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.BLOCKED_TERMINAL_FAILED,
        `reason=${state.reason}`,
        `fingerprint=${state.requestFingerprint}`,
        `error=${formatErr(err)}`,
      );
    });
  }

  /**
   * Phase 1154 Step E: clear persisted blocked state before clearing memory.
   * Returns the previous state. Throws on non-ENOENT deletion errors so the
   * caller cannot report released while the persisted gate remains.
   */
  private _clearLlmRequestBlockedState(): LLMRequestBlockedState {
    const previous = this.llmRequestBlocked;
    if (!previous) {
      throw new Error('LLM request blocked state is not set');
    }

    try {
      this.agentFs.deleteSync(path.join(STATUS_SUBDIR, LLM_REQUEST_BLOCKED_STATE_FILE));
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=clearLlmRequestBlockedState`,
          `reason=${formatErr(error)}`,
        );
        throw error;
      }
    }

    this.llmRequestBlocked = undefined;
    return previous;
  }

  /**
   * P1-11: 从 agentDir 解析 chestnut root 目录。
   * agentDir 形态：<root>/motion（motion）或 <root>/claws/<id>（claw）。
   * 避免 motion 字面，按路径形状判断。
   */
  private _resolveRootFs(
    fsFactory: (baseDir: string) => FileSystem,
    agentDir: string,
  ): FileSystem {
    // 用 path.resolve 而非 path.dirname 避免 no-clawdir-path-anti-pattern。
    const parentDir = path.resolve(agentDir, '..');
    const rootDir = path.basename(parentDir) === 'claws'
      ? path.resolve(parentDir, '..')
      : parentDir;
    return fsFactory(rootDir);
  }
}
