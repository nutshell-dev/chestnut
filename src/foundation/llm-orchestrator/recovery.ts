/**
 * @module L2b.LLMOrchestrator.Recovery
 * @layer L2b LLM 语义基础设施
 *
 * Phase 1826：LLM 调用可用性、失败后自动唤醒、用户干预准入与恢复历史的唯一
 * 决策者。EventLoop 只执行业主给出的 ready/at/on_change 安排与一次尝试准入。
 *
 * - 决定先持久化后发布；写失败不继续真发。
 * - 显式干预只携 opaque id；owner 幂等接收，可提前尝试但不清失败历史。
 * - session 视图（`session.llm`）把 scope 作为每次调用的局部参数，不改全局状态。
 */

import { formatErr, newUuid } from '../node-utils/index.js';
import type { FileSystem } from '../fs/index.js';
import type { LLMResponse } from '../llm-provider/index.js';
import type { LLMCallOptions, LLMEventSink, LLMOrchestrator, LLMStreamChunk } from './types.js';
import type { LLMErrorClass } from './errors.js';
import {
  LLM_RECOVERY_COOLDOWN_MS,
  LLM_RECOVERY_MAX_RETRIES,
  LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  LLM_RECOVERY_QUOTA_MAX_DELAY_MS,
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
  LLM_RECOVERY_RETRY_MAX_DELAY_MS,
} from './defaults.js';
import {
  LLM_RECOVERY_ACCEPTED_IDS_MAX,
  LLM_RECOVERY_FAILURE_EVIDENCE_MAX,
  createInitialRecoveryState,
  importLegacyRecoveryExport,
  loadRecoveryState,
  saveRecoveryState,
  type LegacyRecoveryExport,
  type LLMRecoveryBudget,
  type LLMRecoverySchedule,
  type LLMRecoveryStateV1,
} from './recovery-state.js';

/** scoped 调用的失败输入（orchestrator 侧构造；owner 解释策略）。 */
export interface RecoveryFailureInput {
  providerId: string;
  errorClass: LLMErrorClass;
  message: string;
  /** typed Retry-After（秒）；禁止从 message 正则推导。 */
  retryAfterSec?: number;
  /** true = 仅被本地 breaker 跳过、未发生真实请求：不消耗预算、不计失败数。 */
  localSkip?: boolean;
  /** localSkip 时的最早可尝试时刻（本地 breaker reset）。 */
  probeAllowedAtMs?: number;
}

/**
 * scoped 调用与 owner 会话之间的窄协议。
 * orchestrator 只依赖本接口，不知道 schedule/admission 细节。
 */
export interface RecoveryCallScope {
  noteAttemptStarted(): void;
  noteSuccess(): void;
  noteFailure(failures: readonly RecoveryFailureInput[]): void;
  /**
   * 本次尝试的局部预算与资格（由 owner 的准入唯一决定）：
   * - probeOnly：恢复 probe 模式，每候选至多一次真实调用（正常预算另计）；
   * - allowBreakerProbe：显式干预/启动放行，候选不被本地 breaker 立即拒绝。
   * 不修改全局配置、不置可变标志——同进程其他 caller 不受影响。
   */
  attemptContext(): { probeOnly: boolean; allowBreakerProbe: boolean };
}

/**
 * 具备 scoped 恢复能力的 owner 实例（工厂返回类型）。
 * 公共 call/stream 消费者仍只要求既有最小接口。
 */
export interface LLMOrchestratorOwner extends LLMOrchestrator {
  callWithinRecovery(options: LLMCallOptions, scope: RecoveryCallScope): Promise<LLMResponse>;
  streamWithinRecovery(options: LLMCallOptions, scope: RecoveryCallScope): AsyncIterableIterator<LLMStreamChunk>;
}

/**
 * 触发来源。触发只描述「为什么现在问」；是否放行由 owner 唯一决定。
 * - intervention.ids：当前 pending 的用户来源消息 id 列表（不透明）。owner 判
 *   「存在任一未接受 id」才提前放行并全部记账——同批多 id 归一化为一次干预，
 *   失败回队的同一消息（id 不变）不再放行，第二条真新消息（新 id）仍有效。
 * - configuration.revision：配置身份指纹（不透明）。新 revision 触发重新评估；
 *   同 revision 重复通知不改变历史。
 * - startup.id：本次进程启动标识；仅在 on_change 安排上放行一次（幂等）。
 */
export type LLMRecoveryTrigger =
  | { kind: 'automatic' }
  | { kind: 'intervention'; ids: readonly string[] }
  | { kind: 'configuration'; revision: string }
  | { kind: 'startup'; id: string };

export type LLMRecoveryAdmission =
  | { kind: 'admitted'; attemptId: string }
  | { kind: 'waiting'; schedule: LLMRecoverySchedule };

/** EventLoop 消费的窄 capability。 */
export interface LLMRecoveryController {
  inspect(): Promise<LLMRecoverySchedule>;
  begin(input: { requestKey: string; trigger: LLMRecoveryTrigger }): Promise<LLMRecoveryAdmission>;
  finish(attemptId: string, outcome: 'completed' | 'interrupted' | 'failed'): Promise<void>;
  /** 迁移期：幂等导入旧 owner 的中性导出数据（旧等待保持原 resumeAt）。 */
  adoptLegacy(legacy: LegacyRecoveryExport): { kind: 'imported' | 'already_imported' };
}

export interface LLMRecoverySession extends LLMRecoveryController {
  /** 绑定本 scope 的 LLM 调用视图（同一 owner 的范围视图，非另建实例）。 */
  readonly llm: LLMOrchestrator;
}

export interface RecoverySessionDeps {
  /** 稳定 opaque scope 标识（装配方给出，owner 不解析业务含义）。 */
  scopeId: string;
  /** 注入的持久化范围（目录位置由装配方提供，文件/schema 归 owner）。 */
  fs: FileSystem;
  events: LLMEventSink;
  orchestrator: LLMOrchestratorOwner;
  now?: () => number;
}

function initialBudget(): LLMRecoveryBudget {
  return {
    retryCount: 0,
    retryDelayMs: LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
    quotaDelayMs: LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  };
}

function appendBounded(existing: string[], additions: readonly string[], max: number): string[] {
  const next = [...existing, ...additions];
  return next.length > max ? next.slice(next.length - max) : next;
}

export class LLMRecoverySessionImpl implements LLMRecoverySession, RecoveryCallScope {
  readonly llm: LLMOrchestrator;

  private state: LLMRecoveryStateV1;
  private readonly scopeId: string;
  private readonly fs: FileSystem;
  private readonly events: LLMEventSink;
  private readonly now: () => number;

  constructor(deps: RecoverySessionDeps) {
    this.scopeId = deps.scopeId;
    this.fs = deps.fs;
    this.events = deps.events;
    this.now = deps.now ?? Date.now;

    const load = loadRecoveryState(deps.fs, deps.scopeId);
    if (load.kind === 'unusable') {
      // 拒绝启动并保留原文：不猜默认值继续发请求。
      throw new Error(
        `LLM recovery state is unusable (${load.reason}): ${load.detail}`,
      );
    }
    this.state = load.kind === 'ok'
      ? load.state
      : createInitialRecoveryState(deps.scopeId, initialBudget(), this.now());

    const residual = this.state.activeAdmission;
    if (residual) {
      if (residual.started) {
        // 已开始 → 结果未知：清除句柄并留证据（不虚构成功或失败）。
        this.state = { ...this.state, activeAdmission: null, revision: this.state.revision + 1 };
        this.pushFailure({
          at: new Date(this.now()).toISOString(),
          providerId: 'unknown',
          errorClass: 'unknown',
          message: `attempt ${residual.attemptId} result unknown after restart`,
        });
      } else {
        // 未开始 → 保留已授予、尚未执行的准入：下次 begin 重新驱动同一 attempt
        // （不把未发请求算失败，也不让已记账的干预 id 吞掉这次机会）。
        this.state = {
          ...this.state,
          activeAdmission: { ...residual, resumedFromRestart: true },
          revision: this.state.revision + 1,
        };
      }
      this.state.schedule = { ...this.state.schedule, revision: this.state.revision };
      this.commit();
    }

    this.llm = this.createScopedView(deps.orchestrator);
  }

  // -------------------------------------------------------------------------
  // LLMRecoveryController
  // -------------------------------------------------------------------------

  async inspect(): Promise<LLMRecoverySchedule> {
    return { ...this.state.schedule };
  }

  async begin(input: {
    requestKey: string;
    trigger: LLMRecoveryTrigger;
  }): Promise<LLMRecoveryAdmission> {
    const nowMs = this.now();
    let dirty = false;
    let forceAttempt = false;
    let interventionCount = 0;

    if (input.trigger.kind === 'intervention') {
      const accepted = new Set(this.state.acceptedInterventions);
      const fresh = input.trigger.ids.filter(id => !accepted.has(id));
      if (fresh.length > 0) {
        this.state.acceptedInterventions = appendBounded(
          this.state.acceptedInterventions,
          fresh,
          LLM_RECOVERY_ACCEPTED_IDS_MAX,
        );
        forceAttempt = true;
        interventionCount = fresh.length;
        dirty = true;
      }
    } else if (input.trigger.kind === 'configuration') {
      if (!this.state.acceptedConfigRevisions.includes(input.trigger.revision)) {
        this.state.acceptedConfigRevisions = appendBounded(
          this.state.acceptedConfigRevisions,
          [input.trigger.revision],
          LLM_RECOVERY_ACCEPTED_IDS_MAX,
        );
        // 重新评估：配置变化可能修复 permanent 类阻断（换 key/model）；
        // timed 安排保持（时间窗与配置无关）。
        this.state.providers = this.state.providers.filter(p => p.errorClass !== 'permanent');
        if (this.state.schedule.kind === 'on_change') {
          this.state.schedule = { kind: 'ready', revision: this.state.revision };
        }
        dirty = true;
      }
    } else if (input.trigger.kind === 'startup') {
      if (
        this.state.schedule.kind === 'on_change'
        && this.state.lastStartupProbeId !== input.trigger.id
      ) {
        this.state.lastStartupProbeId = input.trigger.id;
        forceAttempt = true;
        dirty = true;
      }
    }

    const active = this.state.activeAdmission;
    if (active) {
      if (!active.started && active.resumedFromRestart) {
        // Z4：重启前已授予、尚未开始的准入 → 重新驱动同一 attempt
        // （保留原预算/资格；清除 resumed 标记，之后的并发保护照常）。
        active.resumedFromRestart = undefined;
        if (dirty) this.commit();
        this.emit({
          type: 'recovery_attempt_admitted',
          scope: this.scopeId,
          revision: this.state.revision,
          attemptId: active.attemptId,
          trigger: 'resumed',
          interventionCount: 0,
        });
        return { kind: 'admitted', attemptId: active.attemptId };
      }
      // 同 scope 不允许并发 admission；保留当前安排交由调用方串行重试。
      if (dirty) this.commit();
      return { kind: 'waiting', schedule: { ...this.state.schedule } };
    }

    const schedule = this.state.schedule;
    let admitted = false;
    if (schedule.kind === 'ready') {
      admitted = true;
    } else if (schedule.kind === 'at') {
      admitted = nowMs >= Date.parse(schedule.resumeAt) || forceAttempt;
    } else {
      admitted = forceAttempt;
    }

    if (!admitted) {
      if (dirty) this.commit();
      return { kind: 'waiting', schedule: { ...schedule } };
    }

    const attemptId = `att-${newUuid()}`;
    // 局部预算/资格由本次准入唯一决定：
    // - probeOnly：进入本次准入前存在非 ready 安排（到点/干预/配置/启动放行的恢复尝试）
    //   → 每候选至多一次真实调用；
    // - allowBreakerProbe：显式干预或启动放行（forceAttempt 路径）→ 不被旧 breaker 立即拒绝。
    const probeOnly = schedule.kind !== 'ready';
    const allowBreakerProbe = forceAttempt;
    this.state.activeAdmission = {
      attemptId,
      started: false,
      requestKey: input.requestKey,
      triggerKind: input.trigger.kind,
      ...(input.trigger.kind === 'startup' ? { triggerId: input.trigger.id } : {}),
      ...(input.trigger.kind === 'configuration' ? { triggerId: input.trigger.revision } : {}),
      probeOnly,
      allowBreakerProbe,
    };
    this.state.revision += 1;
    this.state.schedule = { ...this.state.schedule, revision: this.state.revision };
    // 持久化失败 → 抛错：调用方不得在写失败后继续真发。
    this.commit();
    this.emit({
      type: 'recovery_attempt_admitted',
      scope: this.scopeId,
      revision: this.state.revision,
      attemptId,
      trigger: input.trigger.kind,
      interventionCount,
    });
    return { kind: 'admitted', attemptId };
  }

  async finish(
    attemptId: string,
    outcome: 'completed' | 'interrupted' | 'failed',
  ): Promise<void> {
    const active = this.state.activeAdmission;
    if (!active || active.attemptId !== attemptId) {
      // 陈旧/未知句柄：不覆盖随后产生的安排，只留观察记录。
      this.emit({
        type: 'recovery_attempt_finished',
        scope: this.scopeId,
        revision: this.state.revision,
        attemptId,
        outcome,
        accepted: false,
      });
      return;
    }
    this.state.activeAdmission = null;
    let dirty = true;
    if (outcome === 'completed' && this.state.schedule.kind !== 'ready') {
      this.state.schedule = { kind: 'ready', revision: this.state.revision + 1 };
      this.state.revision += 1;
    }
    if (dirty) this.commit();
    this.emit({
      type: 'recovery_attempt_finished',
      scope: this.scopeId,
      revision: this.state.revision,
      attemptId,
      outcome,
      accepted: true,
    });
  }

  /** 迁移期：幂等导入旧 owner 的中性导出。 */
  adoptLegacy(legacy: LegacyRecoveryExport): { kind: 'imported' | 'already_imported' } {
    const result = importLegacyRecoveryExport(this.state, legacy, this.now());
    if (result.kind === 'imported') {
      this.state = result.state;
      this.commit();
    }
    return { kind: result.kind };
  }

  // -------------------------------------------------------------------------
  // RecoveryCallScope（scoped 调用反馈）
  // -------------------------------------------------------------------------

  attemptContext(): { probeOnly: boolean; allowBreakerProbe: boolean } {
    const active = this.state.activeAdmission;
    return {
      probeOnly: active?.probeOnly ?? false,
      allowBreakerProbe: active?.allowBreakerProbe ?? false,
    };
  }

  noteAttemptStarted(): void {
    const active = this.state.activeAdmission;
    if (!active || active.started) return;
    active.started = true;
    active.startedAt = new Date(this.now()).toISOString();
    this.commit();
  }

  noteSuccess(): void {
    const budget = this.state.budget;
    const alreadyReady = this.state.schedule.kind === 'ready';
    const budgetClean = budget.retryCount === 0
      && budget.retryDelayMs === LLM_RECOVERY_RETRY_INITIAL_DELAY_MS
      && budget.quotaDelayMs === LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS;
    this.state.budget = initialBudget();
    this.state.providers = this.state.providers.filter(p => p.errorClass !== 'permanent');
    if (alreadyReady && budgetClean) return;  // 无变化不写盘
    this.state.revision += 1;
    this.state.schedule = { kind: 'ready', revision: this.state.revision };
    try {
      this.commit();
    } catch (error) {
      this.emit({
        type: 'recovery_state_write_failed',
        scope: this.scopeId,
        reason: formatErr(error),
        context: 'noteSuccess',
      });
      return;
    }
    this.emit({
      type: 'recovery_ready',
      scope: this.scopeId,
      revision: this.state.revision,
      reason: 'success',
    });
  }

  /**
   * 失败策略的唯一解释点。数值沿用既有已批准参数：
   * transient 30s 起翻倍 cap 5min、quota 2/4/8min、rate_limit 按 typed Retry-After。
   * 仅被本地 breaker 跳过（localSkip）不计预算、不记失败数，但安排不得早于其 reset。
   */
  noteFailure(failures: readonly RecoveryFailureInput[]): void {
    if (failures.length === 0) return;
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    let nextAtMs: number | undefined;
    let lastErrorClass = 'unknown';

    for (const failure of failures) {
      lastErrorClass = failure.errorClass;
      if (failure.localSkip) {
        if (failure.probeAllowedAtMs !== undefined) {
          nextAtMs = nextAtMs === undefined
            ? failure.probeAllowedAtMs
            : Math.min(nextAtMs, failure.probeAllowedAtMs);
        }
        continue;
      }
      this.upsertProviderFact(failure, nowIso);
      this.pushFailure({
        at: nowIso,
        providerId: failure.providerId,
        errorClass: failure.errorClass,
        message: failure.message,
      });

      if (failure.errorClass === 'quota') {
        const delay = this.state.budget.quotaDelayMs;
        this.state.budget.quotaDelayMs = Math.min(delay * 2, LLM_RECOVERY_QUOTA_MAX_DELAY_MS);
        nextAtMs = minDefined(nextAtMs, nowMs + delay);
      } else if (failure.errorClass === 'rate_limit') {
        // 服务端 Retry-After 是权威可尝试时刻：不早于其要求，也不早于独立 cooldown；
        // 客户端 backoff cap 不截短它（旧 phase 1268 cooldown 语义，迁移时须保持）。
        const delay = failure.retryAfterSec !== undefined
          ? Math.max(LLM_RECOVERY_COOLDOWN_MS, failure.retryAfterSec * 1000)
          : this.state.budget.retryDelayMs;
        nextAtMs = minDefined(nextAtMs, nowMs + delay);
      } else if (failure.errorClass === 'permanent') {
        // 无自动恢复路径；只有干预/配置变化可再试。
      } else if (failure.errorClass === 'transient' || failure.errorClass === 'unknown') {
        if (this.state.budget.retryCount < LLM_RECOVERY_MAX_RETRIES) {
          this.state.budget.retryCount += 1;
          const delay = this.state.budget.retryDelayMs;
          this.state.budget.retryDelayMs = Math.min(delay * 2, LLM_RECOVERY_RETRY_MAX_DELAY_MS);
          nextAtMs = minDefined(nextAtMs, nowMs + delay);
        } else {
          nextAtMs = minDefined(nextAtMs, nowMs + LLM_RECOVERY_COOLDOWN_MS);
        }
      }
      // context_exceeded/abort 不进入失败策略（前者归 caller trim，后者非供应商失败）。
    }

    this.state.revision += 1;
    this.state.schedule = nextAtMs === undefined
      ? { kind: 'on_change', revision: this.state.revision }
      : { kind: 'at', revision: this.state.revision, resumeAt: new Date(nextAtMs).toISOString() };
    try {
      this.commit();
    } catch (error) {
      // 内存安排已生效（不继续真发）；持久化失败单独暴露，不掩盖原始 LLM 错误。
      this.emit({
        type: 'recovery_state_write_failed',
        scope: this.scopeId,
        reason: formatErr(error),
        context: 'noteFailure',
      });
      return;
    }
    this.emit({
      type: 'recovery_scheduled',
      scope: this.scopeId,
      revision: this.state.revision,
      scheduleKind: this.state.schedule.kind === 'at' ? 'at' : 'on_change',
      resumeAt: this.state.schedule.kind === 'at' ? this.state.schedule.resumeAt : '',
      errorClass: lastErrorClass,
      providerCount: this.state.providers.length,
      failureCount: this.state.failures.length,
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private createScopedView(orchestrator: LLMOrchestratorOwner): LLMOrchestrator {
    const session = this;
    return {
      call: (options: LLMCallOptions) => orchestrator.callWithinRecovery(options, session),
      stream: (options: LLMCallOptions) => orchestrator.streamWithinRecovery(options, session),
      healthCheck: () => orchestrator.healthCheck(),
      getProviderInfo: () => orchestrator.getProviderInfo(),
      resetLastSuccessProvider: () => orchestrator.resetLastSuccessProvider(),
      // 视图不拥有底层实例：close 不转发，避免误关其他 caller 的 provider/cache。
      close: async () => { /* no-op by design */ },
      reloadConfig: (config) => orchestrator.reloadConfig(config),
    };
  }

  private upsertProviderFact(failure: RecoveryFailureInput, atIso: string): void {
    const existing = this.state.providers.find(p => p.providerId === failure.providerId);
    if (existing) {
      existing.errorClass = failure.errorClass;
      existing.at = atIso;
      existing.consecutiveFailures += 1;
      existing.detail = failure.message;
      return;
    }
    this.state.providers.push({
      providerId: failure.providerId,
      errorClass: failure.errorClass,
      at: atIso,
      consecutiveFailures: 1,
      detail: failure.message,
    });
  }

  private pushFailure(evidence: {
    at: string;
    providerId: string;
    errorClass: string;
    message: string;
  }): void {
    this.state.failures.push(evidence);
    if (this.state.failures.length > LLM_RECOVERY_FAILURE_EVIDENCE_MAX) {
      this.state.failures = this.state.failures.slice(
        this.state.failures.length - LLM_RECOVERY_FAILURE_EVIDENCE_MAX,
      );
    }
  }

  private commit(): void {
    this.state.updatedAt = new Date(this.now()).toISOString();
    saveRecoveryState(this.fs, this.state);
  }

  private emit(event: Parameters<LLMEventSink['emit']>[0]): void {
    this.events.emit(event);
  }
}

function minDefined(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate);
}

export function createRecoverySession(deps: RecoverySessionDeps): LLMRecoverySession {
  return new LLMRecoverySessionImpl(deps);
}
