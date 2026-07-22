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
import type { Runtime, TurnResult } from '../runtime/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { STATUS_SUBDIR } from '../../foundation/process-manager/index.js';
import {
  INBOX_FALLBACK_TIMEOUT_MS_DEFAULT,
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
} from '../../foundation/llm-orchestrator/index.js';
import type { InboxHandle } from '../../foundation/messaging/index.js';
import { PendingViewError } from '../../foundation/messaging/index.js';
import type { LLMRequestBlockedState, LLMRequestGateDecision, EventLoopOptions } from './types.js';

export class EventLoop {
  private runtime: Runtime;
  private clawId: string;
  private audit: AuditLog;
  private loopFs: FileSystem;
  private agentFs: FileSystem;
  private inboxPendingDir: string;
  private fallbackTimeoutMs: number;
  private streamWriter?: StreamWriter;
  private onBatchComplete?: () => Promise<void>;
  private rootFs: FileSystem;

  private stopped = false;

  // LLM failure retry state
  private llmRetryCount = 0;
  private llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;

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
      await this.runtime.nackHandles(addressedHandles, formatErr(result.error) ?? 'failed', 'rollback');
    }
    if (isContextExceededError(result.error)) {
      await this._handleContextExceeded(result.error, failedRequestFingerprint);
      return;
    }
    if (this._isDeterministicInvalidRequest(result.error)) {
      this._enterLlmRequestBlocked({
        version: 2,
        reason: 'invalid_request',
        requestFingerprint: failedRequestFingerprint,
        errorCode: 'LLM_INVALID_REQUEST',
        blockedAt: new Date().toISOString(),
      });
      this._resetLlmRetryState();
      this._saveLlmRetryState();
      return;
    }
    await this._dispatchError(result.error);
  }

  /**
   * Phase 1154 Step E: deterministic invalid-request detection.
   * Only true invalid-request errors (or all-provider failures whose every nested
   * failure is an invalid request) are persisted in the request gate. Mixed or
   * non-invalid-request permanent errors fall through to the normal dispatch path.
   */
  private _isDeterministicInvalidRequest(error: unknown): boolean {
    if (error instanceof LLMInvalidRequestError) return true;
    return (
      error instanceof LLMAllProvidersFailedError
      && error.failures.length > 0
      && error.failures.every(f => f.error instanceof LLMInvalidRequestError)
    );
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
   * Phase 1153 Step C: open-chain execution with per-iteration gate.
   * Each chain iteration recomputes the gate and binds the fingerprint to that
   * turn's failure handling; the run-entry fingerprint is never reused across turns.
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

      const systemPrompt = await this.runtime.getSystemPrompt();
      const tools = this.runtime.getToolsForLLM();
      const sessionMessages = await this.runtime.getMessages();
      let messages = [...sessionMessages, ...injected];
      messages = await this.runtime.proactiveTrimIfNeeded(messages, systemPrompt, tools);

      wrappedCallbacks?.onTurnStart?.(sources);
      const result = await this.runtime.processTurn(messages, systemPrompt, tools, wrappedCallbacks);

      if (result.status === 'success') {
        await this.runtime.ackHandles(addressedHandles, 'normal_turn_end');
        this._resetLlmRetryState();
        this._saveLlmRetryState();

        if (chainIters >= REACT_CHAIN_MAX_ITERATIONS) {
          this.audit.write(
            EVENTLOOP_AUDIT_EVENTS.ITERATION,
            `type=${LOOP_ITERATION_TYPES.chain_limited}`,
            `injected=${firstInjected}`,
            `chain_total=${chainTotal}`,
          );
          break;
        }
        // continue chain loop
      } else if (result.status === 'interrupted') {
        if (result.cause === 'idle_timeout') {
          await this.runtime.nackHandles(addressedHandles, result.cause, 'graceful_interrupt');
        } else {
          await this.runtime.ackHandles(addressedHandles, 'graceful_interrupt');
        }
        break;
      } else {
        await this._handleFailedTurn(result, addressedHandles, turnFingerprint);
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
    const self = this;
    await dispatchError(err, {
      audit: this.audit,
      loopFs: this.loopFs,
      llmRetry: {
        get count() { return self.llmRetryCount; },
        set count(v) { self.llmRetryCount = v; },
        get delayMs() { return self.llmRetryDelayMs; },
        set delayMs(v) { self.llmRetryDelayMs = v; },
      },
      saveLlmRetryState: () => this._saveLlmRetryState(),
    });
  }

  private _resetLlmRetryState(): void {
    this.llmRetryCount = 0;
    this.llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
  }

  private _saveLlmRetryState(): void {
    try {
      this.agentFs.ensureDirSync(STATUS_SUBDIR);
      this.agentFs.writeAtomicSync(
        path.join(STATUS_SUBDIR, LLM_RETRY_STATE_FILE),
        JSON.stringify({
          schema_version: 1,
          llmRetryCount: this.llmRetryCount,
          llmRetryDelayMs: this.llmRetryDelayMs,
          // P1-10: pending 字段已废弃，恒 false 保持 schema 兼容。
          llmRetryPending: false,
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
    if (s.schema_version !== 1) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=schema_version_mismatch`,
        `actual=${String(s.schema_version)}`,
        `expected=1`,
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

    this.llmRetryCount = s.llmRetryCount;
    this.llmRetryDelayMs = s.llmRetryDelayMs;
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
