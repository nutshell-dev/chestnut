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
import type { AuditLog } from '../../foundation/audit/index.js';
import { STATUS_SUBDIR } from '../../foundation/process-manager/index.js';
import {
  INBOX_FALLBACK_TIMEOUT_MS_DEFAULT,
  EXECUTION_INACTIVITY_TIMEOUT_MS,
  EXECUTION_RECOVERY_MESSAGE_TYPE,
  CONTEXT_TRIM_RETRY_MAX,
  CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS,
  CONTEXT_TRIM_RETRY_MAX_DELAY_MS,
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
  classifyLLMError,
} from '../../foundation/llm-orchestrator/index.js';
import type {
  LLMRecoveryController,
  LLMRecoveryFacts,
  LLMRecoverySchedule,
  LegacyRecoveryExport,
} from '../../foundation/llm-orchestrator/index.js';
import { newUuid } from '../../foundation/node-utils/index.js';
import type { InboxHandle } from '../../foundation/messaging/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import { PendingViewError, notifyInbox } from '../../foundation/messaging/index.js';
import {
  createExecutionRecoveryController,
  createExecutionRecoveryStore,
  type ExecutionRecoveryController,
  type ExecutionRecoveryRecord,
} from './execution-recovery.js';
import type { LLMRequestBlockedState, LLMRequestGateDecision, EventLoopOptions, EventLoopRuntime, EventLoopExecutionRecoveryDeps } from './types.js';

/**
 * Phase 1826: 旧 EventLoop retry-state 文件的只读字段形状。
 * 仅供迁移读取（`_readLegacyRecoveryExport`）判别与导出使用，不参与任何调度决策；
 * 新恢复状态由 LLMOrchestrator 的 recovery-state schema 拥有。
 */
interface LegacyRetryStateFileV1V2 {
  schema_version: 1 | 2;
  llmRetryCount: number;
  llmRetryDelayMs: number;
  llmQuotaDelayMs?: number;
  llmRetryPending: boolean;
  waiting?: unknown;
}

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
  private rootFs: FileSystem;

  private stopped = false;

  /**
   * Phase 1826: LLM 恢复安排的唯一 owner（装配期注入）。
   * EventLoop 只消费 ready/at/on_change 与一次尝试准入；不持 count/curve、
   * 不按 quota/transient 重算 deadline。未注入时不做准入（测试/无恢复场景）。
   */
  private recovery?: LLMRecoveryController;
  /**
   * Phase 1827: 本次进程启动标识（每轮随事实重送；owner 幂等记账，只有它判是否已接受）。
   * 同 boot 不重建 token——重建会让 owner 误判为新启动。
   */
  private readonly startupId = `boot-${newUuid()}`;
  /** 当前 owner 准入句柄（turn 结束后结算）。 */
  private activeAttemptId?: string;

  // Phase 1826: context trim 后的有界重试（EventLoop 自有的上下文语义，纯内存预算）
  private contextTrimRetryCount = 0;
  private contextTrimRetryDelayMs = CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS;

  // Phase 1154 Step E: LLM-request blocked state (generalized from context-only gate)
  private llmRequestBlocked?: LLMRequestBlockedState;
  private waitAbortController?: AbortController;

  // Phase 1396 Step E: 执行停滞恢复（record store / resume enqueue 归 EventLoop 自有）
  private executionRecovery?: ExecutionRecoveryController;
  private executionRecoveryDeps?: EventLoopExecutionRecoveryDeps;
  /** processTurn 执行中为 true（observe 只挂在 idle 路径，此字段为未来挂载点保真） */
  private turnInFlight = false;

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
    this.recovery = options.recovery;
    if (options.executionRecovery) {
      this.executionRecoveryDeps = options.executionRecovery;
      this.executionRecovery = createExecutionRecoveryController({
        store: createExecutionRecoveryStore({ rootFs: this.rootFs, audit: this.audit }),
        failureSink: options.executionRecovery.failureSink,
        audit: this.audit,
        timeoutMs: options.executionRecovery.timeoutMs ?? EXECUTION_INACTIVITY_TIMEOUT_MS,
        enqueueResume: (record) => this._enqueueExecutionResume(record),
      });
    }
  }

  /**
   * 启动时恢复：
   * 1. 加载/校验本模块的 blocked state（trim 类 reason），按 phase 1778 启动探测
   *    语义清除一次（启动 = 干预信号）；
   * 2. 消费 clean-stop marker（一次性；不再跳过任何 LLM 恢复状态）；
   * 3. Phase 1826：作为旧 owner 导出旧 LLM 恢复状态、由 owner 幂等导入
   *    （provider 类旧 blocked 同批交接；旧文件原文保留为迁移证据）。
   */
  async initialize(): Promise<void> {
    this.audit.write(EVENTLOOP_AUDIT_EVENTS.ITERATION, `context=initialize`, `claw_id=${this.clawId}`);
    await this._loadLlmRequestBlockedState();
    // phase 1778: 启动 = 干预信号——存在 blocked 时放行一次探测（清除后首轮
    // drain 正常执行；失败由失败路径按新代码分类重建 blocked/waiting）。
    // 理由：blocked 释放条件只有 fingerprint 变——同 provider 换 key 不在
    // fingerprint 组成里、手动重启也不构成释放，用户手动操作（改 key/重启/
    // 等配额恢复）后系统必须有机会验证，而非只能删状态文件或发新消息。
    // 循环风险已论证：probe 失败 → blocked/waiting 重建，daemon 不崩，
    // watchdog 不会因 LLM 失败重启 → 无循环。
    if (this.llmRequestBlocked) {
      const previous = this.llmRequestBlocked;
      let cleared = false;
      try {
        this._clearLlmRequestBlockedState();
        cleared = true;
      } catch {
        // silent: 清除失败已由 _clearLlmRequestBlockedState 内部 FATAL 审计暴露——
        // fail-closed 保留 blocked（文件与内存均未被清），首轮 gate 仍 fail-closed。
      }
      if (cleared) {
        // 独立事件（非 CONTEXT_BLOCKED_RELEASED）：启动探测与 fingerprint 变化释放
        // 可区分；无 new fingerprint 列——清除后首轮按当前事实 drain。
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_STARTUP_PROBE,
          `old=${previous.requestFingerprint}`,
          `reason=${previous.reason}`,
        );
      }
    }
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
    consumeMarker(this.agentFs);   // per-claw
    consumeMarker(this.rootFs);    // global
    // Phase 1826: clean-stop 不再清除已决定的 LLM 恢复等待（旧「跳过加载」特例移除）；
    // marker 的一次性消费语义本身保留（watchdog 另行读取不受影响）。

    this._adoptLegacyLlmRecovery();
  }

  /**
   * 执行一轮事件循环：blocked gate → owner 准入 → drain/chain → 结算。
   *
   * Phase 1154 Step E: 只有 fingerprint 变化或从未 blocked 时才进入 drain+chain；
   * trim 类 no_progress/policy_conflict 会持久化 blocked state，后续 tick 在 drain 前 fail-closed。
   * Phase 1826: LLM 后续尝试由 owner 唯一决定——begin 准入、waiting 时执行 owner
   * 安排（deadline/用户干预/配置变化/启动），turn 结束 finish 结算。
   */
  async run(): Promise<void> {
    this.stopped = false;
    this.waitAbortController = new AbortController();
    let outcome: 'completed' | 'interrupted' | 'failed' = 'failed';

    // Phase 1396 Step E: idle tick 起点做停滞观察（resume/retry/task 在途时自愈逻辑内部跳过）。
    await this._observeExecutionRecovery();

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

      // Phase 1826: 空工作不烧准入（用户干预权留给真消息）。
      if (!(await this._hasPendingWork())) {
        await waitForInbox(
          this.loopFs,
          this.audit,
          this.inboxPendingDir,
          this.fallbackTimeoutMs,
          this.waitAbortController.signal,
        );
        return;
      }

      // Phase 1826: 向 owner 申请准入；waiting 时执行 owner 安排（deadline/干预/配置/控制）。
      const decision = await this._admitTurn(gate.fingerprint);
      if (decision !== 'proceed') return;
      const chainOutcome = await this._runOpenChain(gate.fingerprint);
      outcome = chainOutcome === 'idle' ? 'completed' : chainOutcome;
    } catch (err) {
      outcome = 'failed';
      // EventLoop-level unexpected error
      await this._dispatchError(err);
    } finally {
      const attemptId = this.activeAttemptId;
      this.activeAttemptId = undefined;
      if (attemptId && this.recovery) {
        const settled = this.stopped ? 'interrupted' : outcome;
        try {
          await this.recovery.finish(attemptId, settled);
        } catch (error) {
          this.audit.write(
            EVENTLOOP_AUDIT_EVENTS.FATAL,
            `context=recoveryFinish`,
            `attempt_id=${attemptId}`,
            `reason=${formatErr(error)}`,
          );
        }
      }
      this.waitAbortController = undefined;
    }
  }

  /**
   * Phase 1826/1827: owner 准入循环。
   * - 先看是否有可工作消息（空箱不进入）。
   * - 每轮先应用控制入口（配置生效），再读干预事实；两个读取任一失败都记录原异常、
   *   做一次可中断等待后重读——不用空集合替代失败的读取继续准入。
   * - 本轮全部事实（用户 ids + 实际返回的配置修订 + 稳定启动 token）一次提交；
   *   不以 if/else 选一个事实，事实之间无优先级。
   * - waiting 且 factsAccepted=false（活跃准入挡住）→ 来源保持未消费，等已有工作结束或
   *   兜底超时后重读；waiting 且接受 → 执行 owner 安排，唤醒后重新请求准入。
   * - admitted → 一次 drain/processTurn/finish（新旧消息同批）。
   */
  private async _admitTurn(
    entryFingerprint: string,
  ): Promise<'proceed' | 'stopped' | 'waiting'> {
    const recovery = this.recovery;
    if (!recovery) return 'proceed';

    while (!this.stopped) {
      let configRevision: string | undefined;
      try {
        const controls = await this.runtime.consumePendingControls();
        configRevision = controls?.configRevision;
        if (controls && controls.consumed > 0) {
          this.audit.write(
            EVENTLOOP_AUDIT_EVENTS.ITERATION,
            `type=recovery_controls`,
            `consumed=${controls.consumed}`,
          );
        }
      } catch (error) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=consumePendingControls`,
          `reason=${formatErr(error)}`,
        );
        if (!(await this._waitAfterFactsReadFailure())) return 'stopped';
        continue;
      }

      let userIds: string[] = [];
      try {
        const facts = await this.runtime.peekPendingInterventionFacts();
        userIds = facts?.userIds ?? [];
      } catch (error) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=peekPendingInterventionFacts`,
          `reason=${formatErr(error)}`,
        );
        if (!(await this._waitAfterFactsReadFailure())) return 'stopped';
        continue;
      }

      const facts: LLMRecoveryFacts = {
        interventionIds: userIds,
        ...(configRevision !== undefined ? { configurationRevision: configRevision } : {}),
        startupId: this.startupId,
      };
      const admission = await recovery.begin({ requestKey: entryFingerprint, facts });

      if (admission.kind === 'admitted') {
        this.activeAttemptId = admission.attemptId;
        return 'proceed';
      }

      if (!admission.factsAccepted) {
        // 活跃准入挡住整批：不发 drain、不并发启动 turn，等待已有工作结束或兜底超时后重读。
        if (!(await this._waitAfterFactsReadFailure())) return 'stopped';
        continue;
      }

      const outcome = await this._waitOnSchedule(admission.schedule);
      if (outcome === 'stopped') return 'stopped';
      // recheck：唤醒后重新请求准入（owner 是唯一决策者）。
    }
    return 'stopped';
  }

  /** 事实读取失败/本批被拒后的可中断等待：不空转、不消费来源。 */
  private async _waitAfterFactsReadFailure(): Promise<boolean> {
    if (this.stopped) return false;
    const signal = this.waitAbortController?.signal;
    await waitForInbox(
      this.loopFs,
      this.audit,
      this.inboxPendingDir,
      this.fallbackTimeoutMs,
      signal,
    );
    return !this.stopped;
  }

  /** Phase 1826: 执行 owner 安排——等到 deadline/新 inbox/abort（不重算策略）。 */
  private async _waitOnSchedule(
    schedule: LLMRecoverySchedule,
  ): Promise<'recheck' | 'stopped'> {
    const signal = this.waitAbortController?.signal;
    if (schedule.kind === 'ready') return 'recheck';

    if (schedule.kind === 'on_change') {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.ITERATION,
        `type=recovery_wait`,
        `schedule=on_change`,
        `revision=${schedule.revision}`,
      );
      await waitForInbox(
        this.loopFs,
        this.audit,
        this.inboxPendingDir,
        this.fallbackTimeoutMs,
        signal,
      );
      return this.stopped ? 'stopped' : 'recheck';
    }

    const remainingMs = Date.parse(schedule.resumeAt) - Date.now();
    if (remainingMs <= 0) return 'recheck';
    this.audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `type=recovery_wait`,
      `schedule=at`,
      `revision=${schedule.revision}`,
      `remaining_ms=${remainingMs}`,
    );
    await Promise.race([
      this._sleep(remainingMs, signal),
      waitForInbox(this.loopFs, this.audit, this.inboxPendingDir, remainingMs, signal),
    ]);
    return this.stopped ? 'stopped' : 'recheck';
  }

  /** Phase 1826: 是否有可工作的 pending 事实（普通/控制消息任一）。 */
  private async _hasPendingWork(): Promise<boolean> {
    try {
      const facts = await this.runtime.peekPendingTurnFacts();
      return facts.addressed.length > 0 || facts.controls.length > 0;
    } catch (error) {
      if (error instanceof PendingViewError) {
        // peek 不完整：保守按「有工作」处理，让后续 gate/drain 路径暴露问题。
        return true;
      }
      throw error;
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
      await this.runtime.nackHandles(addressedHandles, formatErr(result.error), 'rollback');
    }
    if (isContextExceededError(result.error)) {
      await this._handleContextExceeded(result.error, failedRequestFingerprint);
      return;
    }
    const errorClass = classifyLLMError(result.error);
    if (
      errorClass === 'transient'
      || errorClass === 'rate_limit'
      || errorClass === 'quota'
      || errorClass === 'permanent'
    ) {
      // Phase 1826: provider/LLM 类失败的恢复安排由 owner（LLMOrchestrator）在
      // scoped 调用内唯一记录并持久化；EventLoop 只做消息处置（上方 nack/ack）
      // 与调度观察，不重算曲线、不进入 provider 类 blocked gate。
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.ITERATION,
        `type=llm_failure_deferred`,
        `error_class=${errorClass}`,
      );
      return;
    }
    await this._dispatchError(result.error);
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
    if (this.contextTrimRetryCount >= CONTEXT_TRIM_RETRY_MAX) {
      this._enterLlmRequestBlocked({
        version: 2,
        reason: 'retry_exhausted',
        requestFingerprint: failedRequestFingerprint,
        attempts: this.contextTrimRetryCount,
        maxAttempts: CONTEXT_TRIM_RETRY_MAX,
        blockedAt: new Date().toISOString(),
      });
      this._resetContextTrimRetryState();
      return;
    }

    const outcome = await this.runtime.reactiveTrim();
    switch (outcome.status) {
      case 'target_reached':
      case 'progress':
        if (!outcome.archived || outcome.after >= outcome.before) {
          throw new Error(`invalid persisted trim outcome: ${outcome.status}`);
        }
        await this._scheduleContextTrimRetry(error);
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
        this._resetContextTrimRetryState();
        return;
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unhandled trim outcome: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Phase 1826: trim 后有界重试（EventLoop 自有预算；不写 LLM 恢复状态）。 */
  private async _scheduleContextTrimRetry(error: unknown): Promise<void> {
    this.contextTrimRetryCount++;
    this.audit.write(
      EVENTLOOP_AUDIT_EVENTS.LLM_RETRY,
      `attempt=${this.contextTrimRetryCount}`,
      `max=${CONTEXT_TRIM_RETRY_MAX}`,
      `delay_ms=${this.contextTrimRetryDelayMs}`,
      `error=${(error as Error).message}`,
    );
    await this._sleep(this.contextTrimRetryDelayMs, this.waitAbortController?.signal);
    this.contextTrimRetryDelayMs = Math.min(
      this.contextTrimRetryDelayMs * 2,
      CONTEXT_TRIM_RETRY_MAX_DELAY_MS,
    );
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
  }): Promise<'continue' | 'break' | 'failed'> {
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
      this.turnInFlight = true;
      const result = await this.runtime
        .processTurn(messages, systemPrompt, tools, args.wrappedCallbacks)
        .finally(() => { this.turnInFlight = false; });
      stage = 'turn_result';

      if (result.status === 'success') {
        dispositionSelected = true;
        await this.runtime.ackHandles(args.addressedHandles, 'normal_turn_end');
        this._resetContextTrimRetryState();
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
      return 'failed';
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
      if (
        postDrainErrorClass === 'transient'
        || postDrainErrorClass === 'rate_limit'
        || postDrainErrorClass === 'quota'
        || postDrainErrorClass === 'permanent'
      ) {
        // Phase 1826: provider/LLM 类失败的恢复安排由 owner 在 scoped 调用内记录；
        // EventLoop 此处只留调度观察（消息已 nack 回队）。
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.ITERATION,
          `type=llm_failure_deferred`,
          `stage=${stage}`,
          `error_class=${postDrainErrorClass}`,
        );
      } else {
        await this._dispatchError(error);
      }
      return 'failed';
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
  private async _runOpenChain(
    entryFingerprint: string,
  ): Promise<'completed' | 'failed' | 'idle'> {
    const wrappedCallbacks = this.streamWriter
      ? createStreamCallbacks(this.streamWriter, this.runtime)
      : undefined;

    let chainIters = 0;
    let chainTotal = 0;
    let firstInjected = 0;
    let turnFingerprint = entryFingerprint;
    let sawFailure = false;

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
          return sawFailure ? 'failed' : 'completed';
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
      if (action === 'failed') {
        sawFailure = true;
        break;
      }
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
      return sawFailure ? 'failed' : 'completed';
    }

    await waitForInbox(
      this.loopFs,
      this.audit,
      this.inboxPendingDir,
      this.fallbackTimeoutMs,
      this.waitAbortController?.signal,
    );
    return 'idle';
  }

  private async _dispatchError(err: unknown): Promise<void> {
    await dispatchError(err, {
      audit: this.audit,
      signal: this.waitAbortController?.signal,
    });
  }

  /**
   * Phase 1396 Step E: 每 tick 起点观察执行停滞。observe 失败不阻断主循环
   * （audit 后继续），恢复失败不能拖垮正常调度。
   */
  private async _observeExecutionRecovery(): Promise<void> {
    if (!this.executionRecovery || !this.executionRecoveryDeps) return;
    try {
      const probe = await this.executionRecoveryDeps.probeActivity();
      // active contract 存在但无持久 activity 事实可判 → 跳过（probe 组装方应以
      // contract 创建时间兜底；仍 null 说明事实源不可用，不得用内存 timer 代替）。
      if (probe.activeContractId && probe.lastActivityAt === null) return;
      await this.executionRecovery.observe({
        executorId: this.clawId,
        activeContractId: probe.activeContractId,
        lastActivityAt: probe.lastActivityAt ?? 0,
        turnInFlight: this.turnInFlight,
        // Phase 1826: owner 准入在途 = 恢复/重试在途（EventLoop 不再自持等待状态）。
        retryInFlight: this.activeAttemptId !== undefined,
        asyncTaskInFlight: (await this.executionRecoveryDeps.isAsyncTaskInFlight?.()) ?? false,
      });
    } catch (err) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=executionRecovery`,
        `reason=${formatErr(err)}`,
      );
    }
  }

  /**
   * Phase 1396 Step E: 自恢复 resume 只走自身 inbox（高优消息，正常 drain 消费），
   * 不直接调 Runtime reentrant API。恢复消息不产生 stream LLM output，
   * 不会被 probe 误判为业务 progress。
   */
  private _enqueueExecutionResume(record: ExecutionRecoveryRecord): void {
    notifyInbox(this.agentFs, {
      inboxDir: this.inboxPendingDir,
      type: EXECUTION_RECOVERY_MESSAGE_TYPE,
      source: this.clawId,
      priority: 'high',
      body: `Execution stalled with no persisted activity; resume work on active contract ${record.contractId} (recovery attempt ${record.attempts}).`,
      metadata: { contract_id: record.contractId },
    }, this.audit);
  }

  /** Phase 1826: trim 重试预算（纯内存，EventLoop 自有语义）。 */
  private _resetContextTrimRetryState(): void {
    this.contextTrimRetryCount = 0;
    this.contextTrimRetryDelayMs = CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS;
  }

  /**
   * Phase 1826: 旧 owner（EventLoop）的恢复状态导出与交接。
   * - 读旧 `llm-retry-state.json`（v1/v2）并构造中性导出数据；
   * - owner 幂等导入（旧等待保持原 resumeAt）；
   * - 旧文件原文保留为只读迁移证据，EventLoop 不再写入。
   */
  private _adoptLegacyLlmRecovery(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    const legacy = this._readLegacyRecoveryExport();
    if (!legacy) return;
    try {
      const result = recovery.adoptLegacy(legacy);
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.ITERATION,
        `type=recovery_adopt`,
        `source=${legacy.source}`,
        `result=${result.kind}`,
      );
    } catch (error) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=recoveryAdopt`,
        `source=${legacy.source}`,
        `reason=${formatErr(error)}`,
      );
    }
  }

  /** 读旧 retry-state 文件并构造中性导出；非法/未来版本 → audit 后不导入。 */
  private _readLegacyRecoveryExport(): LegacyRecoveryExport | undefined {
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
      return undefined;
    }
    if (raw === undefined) return undefined;

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
      return undefined;
    }
    if (typeof saved !== 'object' || saved === null) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=schema_invalid`,
        `actual=${typeof saved}`,
      );
      return undefined;
    }
    const s = saved as LegacyRetryStateFileV1V2;
    if (s.schema_version !== 1 && s.schema_version !== 2) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=schema_version_mismatch`,
        `actual=${String(s.schema_version)}`,
        `expected=2`,
      );
      return undefined;
    }
    if (
      typeof s.llmRetryCount !== 'number'
      || typeof s.llmRetryDelayMs !== 'number'
      || typeof s.llmRetryPending !== 'boolean'
    ) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=field_type_mismatch`,
      );
      return undefined;
    }
    if (s.schema_version === 2 && s.waiting !== null && !this._isValidLegacyWaiting(s.waiting)) {
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=loadLlmRetryState`,
        `reason=field_type_mismatch`,
        `field=waiting`,
      );
      return undefined;
    }
    if (s.llmRetryPending === true) {
      // P1-10: 旧文件 pending=true 不再恢复，消息已由 inflight reconcile 重投。
      this.audit.write(
        EVENTLOOP_AUDIT_EVENTS.ITERATION,
        `context=loadLlmRetryState`,
        `reason=legacy_pending_ignored`,
      );
    }

    const waiting = s.schema_version === 2 && s.waiting !== null
      ? this._toLegacyWaitingExport(s.waiting as Record<string, unknown>)
      : null;
    return {
      source: `llm-retry-state.json@v${String(s.schema_version)}`,
      retryCount: s.llmRetryCount,
      retryDelayMs: s.llmRetryDelayMs,
      ...(typeof s.llmQuotaDelayMs === 'number' ? { quotaDelayMs: s.llmQuotaDelayMs } : {}),
      waiting,
    };
  }

  /** legacy waiting 判别联合校验（旧 schema；非法/猜测字段一律拒绝）。 */
  private _isValidLegacyWaiting(waiting: unknown): boolean {
    if (typeof waiting !== 'object' || waiting === null) return false;
    const w = waiting as Record<string, unknown>;
    if (w.kind !== 'retry' && w.kind !== 'cooldown') return false;
    if (typeof w.requestFingerprint !== 'string' || w.requestFingerprint.length === 0) return false;
    if (w.errorClass !== 'transient' && w.errorClass !== 'rate_limit' && w.errorClass !== 'quota') return false;
    if (typeof w.scheduledAt !== 'string' || typeof w.resumeAt !== 'string') return false;
    if (typeof w.error !== 'string') return false;
    if (typeof w.maxAttempts !== 'number') return false;
    if (w.kind === 'retry') return typeof w.attempt === 'number';
    return typeof w.attempts === 'number';
  }

  private _toLegacyWaitingExport(w: Record<string, unknown>): LegacyRecoveryExport['waiting'] {
    return {
      kind: w.kind === 'cooldown' ? 'cooldown' : 'retry',
      errorClass: String(w.errorClass),
      resumeAt: String(w.resumeAt),
      ...(typeof w.attempt === 'number' ? { attempt: w.attempt } : {}),
      ...(typeof w.attempts === 'number' ? { attempts: w.attempts } : {}),
      ...(typeof w.maxAttempts === 'number' ? { maxAttempts: w.maxAttempts } : {}),
      ...(typeof w.error === 'string' ? { error: w.error } : {}),
    };
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

    // Phase 1826: provider 类阻断（invalid_request / permanent_provider_error）
    // 归 owner（on_change 安排 + 原错误证据）；EventLoop 不再持有，消除双 owner。
    // trim 类 reason（no_progress/policy_conflict/retry_exhausted）仍归本模块。
    if (saved.reason === 'invalid_request' || saved.reason === 'permanent_provider_error') {
      this._adoptLegacyBlockedState(saved);
      return;
    }
    this.llmRequestBlocked = saved;
  }

  /** Phase 1826: 把 provider 类旧阻断交接给 owner（幂等；成功后删除旧文件，不双写）。 */
  private _adoptLegacyBlockedState(state: LLMRequestBlockedState): void {
    const recovery = this.recovery;
    if (recovery) {
      try {
        recovery.adoptLegacy({
          source: 'llm-request-blocked-state.json@v2',
          blocked: {
            reason: state.reason,
            requestFingerprint: state.requestFingerprint,
            blockedAt: state.blockedAt,
            ...(state.reason === 'permanent_provider_error' ? { message: state.message } : {}),
          },
        });
      } catch (error) {
        // 迁移失败：保留内存 gate 与文件（fail-closed，不丢失阻断信息）。
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=adoptLegacyBlocked`,
          `reason=${formatErr(error)}`,
        );
        this.llmRequestBlocked = state;
        return;
      }
    }
    try {
      this.agentFs.deleteSync(path.join(STATUS_SUBDIR, LLM_REQUEST_BLOCKED_STATE_FILE));
    } catch (error) {
      if (!isFileNotFound(error)) {
        this.audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=adoptLegacyBlocked`,
          `reason=legacy_delete_failed`,
          `error=${formatErr(error)}`,
        );
        this.llmRequestBlocked = state;
        return;
      }
    }
    this.audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `type=recovery_adopt`,
      `source=llm-request-blocked-state.json@v2`,
      `reason=${state.reason}`,
    );
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
      maxAttempts: legacy.maxAttempts ?? CONTEXT_TRIM_RETRY_MAX,
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
