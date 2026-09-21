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
 *
 * Phase 1827：一次 begin 接收本轮全部恢复事实（干预 ids / 配置修订 / 启动 token），
 * 事实互不遮蔽；接受记账、安排与至多一次准入在同一原子提交中完成，完整接受事实
 * 持久保留，单一显示原因不替代全部证据。
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
  loadRecoveryState,
  saveRecoveryState,
  type LLMRecoveryAcceptedFactBatch,
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
 * Phase 1827: 一轮内观察到的全部恢复事实（只描述「观察到什么」；是否放行由 owner 唯一决定）。
 * 事实之间无优先级——同轮共存的事实一次提交、全部幂等接受，不因某个事实先到达而遮蔽其余。
 * - interventionIds：当前 pending 的用户来源消息 id 列表（不透明）。owner 判
 *   「存在任一未接受 id」才提前放行并全部记账——同批多 id 归一化为一次干预，
 *   失败回队的同一消息（id 不变）不再放行，第二条真新消息（新 id）仍有效。
 * - configurationRevision：本轮实际成功应用的最新配置身份（不透明），不是变更历史队列。
 *   新修订触发重新评估；同修订重复通知不改变历史。
 * - startupId：本次进程启动标识；同一 boot 每轮可重送，owner 幂等记账，
 *   仅在 on_change 入口放行一次资格。
 * 空集合 = 自动检查；是否到期由 owner 的时钟判定，timer 不授予资格。
 */
export interface LLMRecoveryFacts {
  readonly interventionIds: readonly string[];
  readonly configurationRevision?: string;
  readonly startupId?: string;
}

export type LLMRecoveryAdmission =
  | { kind: 'admitted'; attemptId: string; factsAccepted: true }
  | { kind: 'waiting'; schedule: LLMRecoverySchedule; factsAccepted: boolean };

/** EventLoop 消费的窄 capability。 */
export interface LLMRecoveryController {
  inspect(): Promise<LLMRecoverySchedule>;
  begin(input: { requestKey: string; facts: LLMRecoveryFacts }): Promise<LLMRecoveryAdmission>;
  finish(attemptId: string, outcome: 'completed' | 'interrupted' | 'failed'): Promise<void>;
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

  /**
   * Phase 1827: 一次提交全部恢复事实，由 owner 幂等接受并至多产生一次准入。
   *
   * 固定顺序（事实之间无优先级）：
   * 1. 去重输入 ids；记录入口安排（probeOnly 判定用）；
   * 2. 活跃且非「重启恢复未开始」的准入 → waiting/factsAccepted=false，不接收任何事实；
   * 3. 复制状态，后续只改副本；计算全部新事实差集；
   * 4. 新配置修订 → 重新评估 on_change（at 的 deadline 不变），不清预算与失败证据；
   * 5. 全部新干预 ids 一次记账，任一新 id 授予一次提前资格；
   * 6. 新启动 token 一律记为本 boot 已处理，仅 on_change 入口授予一次启动资格；
   * 7. 在配置评估后的安排上只做一次准入判断；
   * 8. 重启恢复的未开始准入：合入本批新事实、解除 resumed 标记，不建第二个 attempt；
   * 9-11. 去重/安排/接受证据/准入一次原子保存，成功后才替换内存并发布事件。
   */
  async begin(input: {
    requestKey: string;
    facts: LLMRecoveryFacts;
  }): Promise<LLMRecoveryAdmission> {
    const nowMs = this.now();
    const entrySchedule = this.state.schedule;
    const dedupedIds = dedupeStrings(input.facts.interventionIds);

    // 活跃准入挡住整批：不记账、不改安排、不发布接受事件；来源可重送。
    const active = this.state.activeAdmission;
    const resumable = active !== null && active.resumedFromRestart === true && !active.started;
    if (active && !resumable) {
      return { kind: 'waiting', schedule: { ...this.state.schedule }, factsAccepted: false };
    }

    const next: LLMRecoveryStateV1 = {
      ...this.state,
      budget: { ...this.state.budget },
      providers: [...this.state.providers],
      acceptedInterventions: [...this.state.acceptedInterventions],
      acceptedConfigRevisions: [...this.state.acceptedConfigRevisions],
      failures: [...this.state.failures],
      importedSources: [...this.state.importedSources],
      ...(this.state.acceptedFactBatches
        ? { acceptedFactBatches: [...this.state.acceptedFactBatches] }
        : {}),
    };
    let stateChanged = false;
    const acceptedFacts: {
      interventionIds: string[];
      configurationRevision?: string;
      startupId?: string;
    } = { interventionIds: [] };

    // 4. 新配置修订：重新评估 permanent 阻断；at 的时间窗不因配置缩短。
    const configRevision = input.facts.configurationRevision;
    if (configRevision !== undefined && !next.acceptedConfigRevisions.includes(configRevision)) {
      next.acceptedConfigRevisions = appendBounded(
        next.acceptedConfigRevisions,
        [configRevision],
        LLM_RECOVERY_ACCEPTED_IDS_MAX,
      );
      next.providers = next.providers.filter(p => p.errorClass !== 'permanent');
      if (next.schedule.kind === 'on_change') {
        next.schedule = { kind: 'ready', revision: next.revision };
      }
      acceptedFacts.configurationRevision = configRevision;
      stateChanged = true;
    }

    // 5. 全部新干预 ids 一次记账；多 id 归一化为一次资格，旧 id 不授予新资格。
    const freshIds = dedupedIds.filter(id => !next.acceptedInterventions.includes(id));
    if (freshIds.length > 0) {
      next.acceptedInterventions = appendBounded(
        next.acceptedInterventions,
        freshIds,
        LLM_RECOVERY_ACCEPTED_IDS_MAX,
      );
      acceptedFacts.interventionIds = freshIds;
      stateChanged = true;
    }
    const hasUserQualification = freshIds.length > 0;

    // 6. 新启动 token：不论入口安排都记为本 boot 已处理（ready/at 时不能留到本 boot
    // 稍后失败再获得启动机会）；仅 on_change 入口授予一次启动资格。
    let hasStartupQualification = false;
    const startupId = input.facts.startupId;
    if (startupId !== undefined && startupId !== next.lastStartupProbeId) {
      next.lastStartupProbeId = startupId;
      acceptedFacts.startupId = startupId;
      stateChanged = true;
      if (entrySchedule.kind === 'on_change') hasStartupQualification = true;
    }

    const hasNewFacts = acceptedFacts.interventionIds.length > 0
      || acceptedFacts.configurationRevision !== undefined
      || acceptedFacts.startupId !== undefined;

    if (resumable && active) {
      // 8. Z4+1827：重启前已授予、尚未开始的准入 → 合入本批新事实并重新驱动同一 attempt。
      // 不做第二次准入判断；保留原预算/资格，只合入确有的新资格。
      next.activeAdmission = {
        ...active,
        resumedFromRestart: undefined,
        interventionIds: mergeIds(active.interventionIds ?? [], acceptedFacts.interventionIds),
        ...(acceptedFacts.configurationRevision !== undefined
          ? { configurationRevision: acceptedFacts.configurationRevision }
          : active.configurationRevision !== undefined
            ? { configurationRevision: active.configurationRevision }
            : {}),
        ...(acceptedFacts.startupId !== undefined
          ? { startupId: acceptedFacts.startupId }
          : active.startupId !== undefined
            ? { startupId: active.startupId }
            : {}),
        allowBreakerProbe: (active.allowBreakerProbe ?? false)
          || hasUserQualification
          || hasStartupQualification,
      };
      next.revision += 1;
      next.schedule = { ...next.schedule, revision: next.revision };
      if (hasNewFacts) {
        next.acceptedFactBatches = appendFactBatch(next, acceptedFacts, active.attemptId);
      }
      this.commitNext(next);
      if (hasNewFacts) this.emitFactsAccepted(next.revision, acceptedFacts, active.attemptId);
      this.emit({
        type: 'recovery_attempt_admitted',
        scope: this.scopeId,
        revision: next.revision,
        attemptId: active.attemptId,
        trigger: 'resumed',
        interventionCount: acceptedFacts.interventionIds.length,
      });
      return { kind: 'admitted', attemptId: active.attemptId, factsAccepted: true };
    }

    // 7. 一次准入判断（配置单独到达不缩短 at；系统消息不赋予资格）。
    const schedule = next.schedule;
    let admitted = false;
    if (schedule.kind === 'ready') {
      admitted = true;
    } else if (schedule.kind === 'at') {
      admitted = nowMs >= Date.parse(schedule.resumeAt) || hasUserQualification;
    } else {
      admitted = hasUserQualification || hasStartupQualification;
    }

    if (!admitted) {
      if (!stateChanged) {
        // 无新事实：幂等返回，不伪造接受事件。
        return { kind: 'waiting', schedule: { ...this.state.schedule }, factsAccepted: true };
      }
      next.revision += 1;
      next.schedule = { ...next.schedule, revision: next.revision };
      if (hasNewFacts) {
        next.acceptedFactBatches = appendFactBatch(next, acceptedFacts, undefined);
      }
      this.commitNext(next);
      if (hasNewFacts) this.emitFactsAccepted(next.revision, acceptedFacts, undefined);
      return { kind: 'waiting', schedule: { ...next.schedule }, factsAccepted: true };
    }

    const attemptId = `att-${newUuid()}`;
    // 9. 局部预算/资格由本次准入唯一决定：
    // - probeOnly：入口安排非 ready（恢复 probe 上下文）→ 每候选至多一次真实调用；
    //   配置先置 ready 不恢复为正常 3 次预算。
    // - allowBreakerProbe：仅有效新用户/启动资格授予（配置不授予）。
    const probeOnly = entrySchedule.kind !== 'ready';
    const allowBreakerProbe = hasUserQualification || hasStartupQualification;
    const summary = summarizeAdmission(acceptedFacts, {
      user: hasUserQualification,
      startup: hasStartupQualification,
    });
    next.activeAdmission = {
      attemptId,
      started: false,
      requestKey: input.requestKey,
      triggerKind: summary.kind,
      ...(summary.id !== undefined ? { triggerId: summary.id } : {}),
      interventionIds: [...acceptedFacts.interventionIds],
      ...(acceptedFacts.configurationRevision !== undefined
        ? { configurationRevision: acceptedFacts.configurationRevision }
        : {}),
      ...(acceptedFacts.startupId !== undefined ? { startupId: acceptedFacts.startupId } : {}),
      probeOnly,
      allowBreakerProbe,
    };
    next.revision += 1;
    next.schedule = { ...next.schedule, revision: next.revision };
    if (hasNewFacts) {
      next.acceptedFactBatches = appendFactBatch(next, acceptedFacts, attemptId);
    }
    // 去重、安排、接受证据与准入一次原子保存；失败抛错，内存与来源不前移。
    this.commitNext(next);
    if (hasNewFacts) this.emitFactsAccepted(next.revision, acceptedFacts, attemptId);
    this.emit({
      type: 'recovery_attempt_admitted',
      scope: this.scopeId,
      revision: next.revision,
      attemptId,
      trigger: summary.kind,
      interventionCount: acceptedFacts.interventionIds.length,
    });
    return { kind: 'admitted', attemptId, factsAccepted: true };
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

  /** 先保存后替换内存：写失败抛错时调用方不得继续真发，内存仍为旧状态。 */
  private commitNext(next: LLMRecoveryStateV1): void {
    next.updatedAt = new Date(this.now()).toISOString();
    saveRecoveryState(this.fs, next);
    this.state = next;
  }

  /** 事实接受证据（磁盘记录权威；事件出口尽力而为，重复事实不伪造新事件）。 */
  private emitFactsAccepted(
    revision: number,
    accepted: AcceptedFacts,
    attemptId: string | undefined,
  ): void {
    this.emit({
      type: 'recovery_facts_accepted',
      scope: this.scopeId,
      revision,
      interventionIds: [...accepted.interventionIds],
      ...(accepted.configurationRevision !== undefined
        ? { configurationRevision: accepted.configurationRevision }
        : {}),
      ...(accepted.startupId !== undefined ? { startupId: accepted.startupId } : {}),
      ...(attemptId !== undefined ? { attemptId } : {}),
    });
  }

  private emit(event: Parameters<LLMEventSink['emit']>[0]): void {
    this.events.emit(event);
  }
}

interface AcceptedFacts {
  interventionIds: readonly string[];
  configurationRevision?: string;
  startupId?: string;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function mergeIds(existing: readonly string[], additions: readonly string[]): string[] {
  return dedupeStrings([...existing, ...additions]);
}

/** 只追加、不截断：接受历史是证据，事件出口不可靠，磁盘记录必须完整。 */
function appendFactBatch(
  next: LLMRecoveryStateV1,
  accepted: AcceptedFacts,
  attemptId: string | undefined,
): LLMRecoveryAcceptedFactBatch[] {
  const batch: LLMRecoveryAcceptedFactBatch = {
    scope: next.scopeId,
    revision: next.revision,
    interventionIds: [...accepted.interventionIds],
    ...(accepted.configurationRevision !== undefined
      ? { configurationRevision: accepted.configurationRevision }
      : {}),
    ...(accepted.startupId !== undefined ? { startupId: accepted.startupId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
  };
  return [...(next.acceptedFactBatches ?? []), batch];
}

/** 显示兼容摘要：只选一个主原因，完整信息由事实证据关联。 */
function summarizeAdmission(
  accepted: AcceptedFacts,
  qualifications: { user: boolean; startup: boolean },
): { kind: string; id?: string } {
  if (qualifications.user) return { kind: 'intervention' };
  if (qualifications.startup) {
    return accepted.startupId !== undefined
      ? { kind: 'startup', id: accepted.startupId }
      : { kind: 'startup' };
  }
  if (accepted.configurationRevision !== undefined) {
    return { kind: 'configuration', id: accepted.configurationRevision };
  }
  return { kind: 'automatic' };
}

function minDefined(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate);
}

export function createRecoverySession(deps: RecoverySessionDeps): LLMRecoverySession {
  return new LLMRecoverySessionImpl(deps);
}
