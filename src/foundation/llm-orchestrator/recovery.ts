/**
 * Orchestrator 内部恢复 controller。状态由 LLMOrchestratorImpl 的统一实例提交屏障持久化；
 * 本模块不拥有文件、不构造 session，也不向公共 barrel 暴露 begin/finish 控制面。
 */
import { formatErr, newUuid, sha256ShortHex } from '../node-utils/index.js';
import type {
  LLMCallOptions,
  LLMRecoveryFacts,
  LLMEventSink,
  LLMFailureDisposition,
  LLMInstanceSnapshot,
  LLMOrchestrator,
  LLMProbeResult,
  LLMRuntimeCapability,
} from './types.js';
import type { LLMErrorClass } from './errors.js';
import {
  LLM_RECOVERY_COOLDOWN_MS,
  LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  LLM_RECOVERY_QUOTA_MAX_DELAY_MS,
  LLM_RECOVERY_RATE_LIMIT_BACKOFF_MS,
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
  LLM_RECOVERY_RETRY_MAX_DELAY_MS,
} from './defaults.js';
import {
  LLM_RECOVERY_ACCEPTED_IDS_MAX,
  LLM_RECOVERY_FAILURE_EVIDENCE_MAX,
  LLM_RECOVERY_FAILURE_EVIDENCE_POLICY_VERSION,
  type LLMRecoveryFailureEvidence,
  type LLMRecoverySchedule,
} from './recovery-state.js';
import type {
  LLMInstanceAcceptedFactBatch,
  LLMInstanceInvocation,
  LLMInstanceRecoveryProviderFact,
  LLMInstanceRecoveryState,
  LLMProviderRecoveryState,
} from './instance-state.js';

export interface RecoveryFailureInput {
  providerId: string;
  errorClass: LLMErrorClass;
  message: string;
  retryAfterSec?: number;
  /** L1 已解析并校验时区的 quota reset 下界。 */
  resetAtMs?: number;
  localSkip?: boolean;
  probeAllowedAtMs?: number;
  providerLabel?: string;
  invocationId?: string;
  attemptId?: string;
  attemptIndex?: number;
  configRevision?: number;
  /** 错误发生时刻（ms epoch）；typed Retry-After 下界以此为准。 */
  occurredAtMs?: number;
}

export interface LLMRecoverySignal {
  subscribeReady(listener: () => void): () => void;
  scheduleProbe(atMs: number): void;
}

export type SharedRecoveryDecision =
  | { kind: 'ready' }
  | { kind: 'at'; nextProbeAt: number }
  | { kind: 'on_change' };

/** 唯一真实 owner；所有直接注入方均通过其公共 call/stream 进入恢复。 */
export interface LLMOrchestratorOwner extends LLMOrchestrator, LLMRuntimeCapability, LLMRecoverySignal {
  healthCheck(): Promise<boolean>;
  isClosed(): boolean;
  inspectRecoverySchedule(): Promise<LLMRecoverySchedule>;
  snapshot(): LLMInstanceSnapshot;
  probe(): Promise<LLMProbeResult>;
  getSharedRecoveryDecision(): SharedRecoveryDecision;
  getFailureDisposition(error: unknown): LLMFailureDisposition;
  getProviderIdentities(): readonly string[];
  getLegacyProviderIdentities(): readonly string[];
}

export type { LLMRecoveryFacts } from './types.js';

export type LLMRecoveryAdmission =
  | { kind: 'admitted'; invocationId: string; attemptId: string; factsAccepted: true }
  | { kind: 'waiting'; schedule: LLMRecoverySchedule; factsAccepted: boolean };

interface RecoveryControllerDeps {
  instanceId: string;
  events: LLMEventSink;
  orchestrator: Pick<LLMOrchestratorOwner, 'getProviderIdentities' | 'getLegacyProviderIdentities'>;
  getState(): LLMInstanceRecoveryState;
  getRevision(): number;
  getProviders(): readonly LLMProviderRecoveryState[];
  /** 同步 durable commit；成功返回已提交 revision，失败必须 throw 且不得发布候选。 */
  commit(next: LLMInstanceRecoveryState, context: string, providers?: readonly LLMProviderRecoveryState[]): number;
  now?: () => number;
}

interface AcceptedFacts {
  interventionIds: readonly string[];
  configurationRevision?: string;
  startupId?: string;
}

function appendBounded(existing: string[], additions: readonly string[], max: number): string[] {
  const next = [...existing, ...additions];
  return next.length > max ? next.slice(next.length - max) : next;
}

function cloneRecovery(state: LLMInstanceRecoveryState): LLMInstanceRecoveryState {
  return {
    ...state,
    budget: { ...state.budget },
    providers: state.providers.map(fact => ({ ...fact })),
    acceptedInterventions: [...state.acceptedInterventions],
    acceptedConfigRevisions: [...state.acceptedConfigRevisions],
    invocations: state.invocations.map(invocation => ({
      ...invocation,
      ...(invocation.interventionIds ? { interventionIds: [...invocation.interventionIds] } : {}),
    })),
    failures: [...state.failures],
    importedSources: [...state.importedSources],
    ...(state.failureEvidenceLoss ? { failureEvidenceLoss: { ...state.failureEvidenceLoss } } : {}),
    ...(state.acceptedFactBatches
      ? { acceptedFactBatches: state.acceptedFactBatches.map(batch => ({ ...batch, interventionIds: [...batch.interventionIds] })) }
      : {}),
  };
}

/** schedule 是每个 provider 唯一恢复事实的只读派生，不进入磁盘 schema。 */
export function deriveLLMRecoverySchedule(
  state: LLMInstanceRecoveryState | readonly LLMProviderRecoveryState[],
  revision: number,
  currentProviderIds: readonly string[] = [],
): LLMRecoverySchedule {
  // 保留旧 recovery-state 输入仅供迁移测试；生产 controller 只传统一 provider state。
  if (!Array.isArray(state)) {
    const legacy = state as LLMInstanceRecoveryState;
    const blocked = legacy.providers.filter(fact => fact.blocking);
    const blockedIds = new Set(blocked.map(fact => fact.providerId));
    if (blocked.length === 0 || currentProviderIds.some(providerId => !blockedIds.has(providerId))) {
      return { kind: 'ready', revision };
    }
    let earliest: string | undefined;
    for (const fact of blocked) {
      if (fact.retryAt === undefined) continue;
      if (earliest === undefined || Date.parse(fact.retryAt) < Date.parse(earliest)) earliest = fact.retryAt;
    }
    return earliest === undefined
      ? { kind: 'on_change', revision }
      : { kind: 'at', revision, resumeAt: earliest };
  }

  const providers = state as readonly LLMProviderRecoveryState[];
  const byId = new Map(providers.map(provider => [provider.providerId, provider]));
  const current = currentProviderIds.length > 0
    ? currentProviderIds.map(providerId => byId.get(providerId))
    : providers;
  const blocked = current.filter((provider): provider is LLMProviderRecoveryState => provider?.status === 'waiting');
  if (blocked.length === 0 || current.some(provider => provider === undefined || provider.status === 'available')) {
    return { kind: 'ready', revision };
  }
  let earliest: number | undefined;
  for (const provider of blocked) {
    if (provider.retryAt === undefined) continue;
    if (earliest === undefined || provider.retryAt < earliest) earliest = provider.retryAt;
  }
  return earliest === undefined
    ? { kind: 'on_change', revision }
    : { kind: 'at', revision, resumeAt: new Date(earliest).toISOString() };
}

function hasAcceptedFact(
  state: LLMInstanceRecoveryState,
  kind: 'intervention' | 'configuration',
  id: string,
): boolean {
  if (kind === 'intervention' && state.acceptedInterventions.includes(id)) return true;
  if (kind === 'configuration' && state.acceptedConfigRevisions.includes(id)) return true;
  return (state.acceptedFactBatches ?? []).some(batch =>
    kind === 'intervention'
      ? batch.interventionIds.includes(id)
      : batch.configurationRevision === id,
  );
}

export class LLMRecoveryControllerImpl {
  private readonly instanceId: string;
  private readonly events: LLMEventSink;
  private readonly orchestrator: RecoveryControllerDeps['orchestrator'];
  private readonly getState: RecoveryControllerDeps['getState'];
  private readonly getRevision: RecoveryControllerDeps['getRevision'];
  private readonly getProviders: RecoveryControllerDeps['getProviders'];
  private readonly commit: RecoveryControllerDeps['commit'];
  private readonly now: () => number;

  constructor(deps: RecoveryControllerDeps) {
    this.instanceId = deps.instanceId;
    this.events = deps.events;
    this.orchestrator = deps.orchestrator;
    this.getState = deps.getState;
    this.getRevision = deps.getRevision;
    this.getProviders = deps.getProviders;
    this.commit = deps.commit;
    this.now = deps.now ?? Date.now;
    this.migrateProviderIdentities();
    this.recoverInvocationsAfterRestart();
  }

  async inspect(): Promise<LLMRecoverySchedule> {
    return deriveLLMRecoverySchedule(this.getProviders(), this.getRevision(), this.orchestrator.getProviderIdentities());
  }

  private migrateProviderIdentities(): void {
    const legacyToCurrent = new Map<string, string>();
    const currentIds = this.orchestrator.getProviderIdentities();
    const legacyIds = this.orchestrator.getLegacyProviderIdentities();
    for (let i = 0; i < currentIds.length; i++) {
      const currentId = currentIds[i];
      const legacyId = legacyIds[i];
      if (currentId !== undefined && legacyId !== undefined && legacyId !== currentId) {
        legacyToCurrent.set(legacyId, currentId);
      }
    }
    const state = this.getState();
    let migrated = false;
    const next = cloneRecovery(state);
    next.providers = next.providers.map(fact => {
      const currentId = legacyToCurrent.get(fact.providerId);
      if (currentId === undefined) return fact;
      migrated = true;
      return { ...fact, providerId: currentId, identityMigrationPending: true };
    });
    const providers = this.getProviders().map(provider => ({ ...provider }));
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      const currentId = legacyToCurrent.get(provider.providerId);
      if (currentId === undefined) continue;
      if (providers.some((other, index) => index !== i && other.providerId === currentId)) {
        throw new Error(`legacy provider identity migration conflicts at ${currentId}`);
      }
      provider.providerId = currentId;
      migrated = true;
    }
    if (migrated) this.commitNext(next, 'migration', providers);
  }

  private recoverInvocationsAfterRestart(): void {
    const state = this.getState();
    if (state.invocations.length === 0) return;
    const next = cloneRecovery(state);
    const retained: LLMInstanceInvocation[] = [];
    let changed = false;
    for (const invocation of state.invocations) {
      if (invocation.started) {
        changed = true;
        this.pushFailure(next, {
          at: new Date(this.now()).toISOString(),
          providerId: 'unknown',
          errorClass: 'unknown',
          message: `invocation ${invocation.invocationId} attempt ${invocation.attemptId} result unknown after restart`,
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
        });
      } else {
        if (invocation.resumedFromRestart !== true) changed = true;
        retained.push({ ...invocation, resumedFromRestart: true });
      }
    }
    next.invocations = retained;
    if (changed) this.commitNext(next, 'constructor');
  }

  async begin(input: { requestKey: string; facts: LLMRecoveryFacts }): Promise<LLMRecoveryAdmission> {
    const nowMs = this.now();
    const state = this.getState();
    const entrySchedule = deriveLLMRecoverySchedule(this.getProviders(), this.getRevision(), this.orchestrator.getProviderIdentities());
    const dedupedIds = dedupeStrings(input.facts.interventionIds);
    const resumableMatches = state.invocations.filter(invocation =>
      invocation.resumedFromRestart === true && !invocation.started && invocation.requestKey === input.requestKey,
    );
    if (resumableMatches.length > 1) {
      throw new Error(`multiple restart invocations match requestKey ${input.requestKey}; refusing to guess`);
    }
    const active = resumableMatches[0];
    const next = cloneRecovery(state);
    let stateChanged = false;
    const acceptedFacts: AcceptedFacts = { interventionIds: [] };

    const configRevision = input.facts.configurationRevision;
    if (configRevision !== undefined && !hasAcceptedFact(next, 'configuration', configRevision)) {
      next.acceptedConfigRevisions = appendBounded(next.acceptedConfigRevisions, [configRevision], LLM_RECOVERY_ACCEPTED_IDS_MAX);
      const currentIds = new Set(this.orchestrator.getProviderIdentities());
      let released = false;
      next.providers = next.providers.flatMap(fact => {
        const changed = fact.identityMigrationPending === true || !currentIds.has(fact.providerId);
        if (!changed) return [fact];
        if (fact.errorClass === 'permanent') {
          released = true;
          return [];
        }
        if (fact.rateLimitBlocked === true) released = true;
        return [clearIdentityMigrationPending(releaseRateLimitBlocked(fact))];
      });
      const stillBlocked = next.providers.some(fact =>
        fact.blocking && (fact.errorClass === 'permanent' || fact.rateLimitBlocked === true),
      );
      if (released && entrySchedule.kind === 'on_change' && !stillBlocked) {
        next.providers = next.providers.map(fact => ({ ...fact, blocking: false, retryAt: undefined }));
      }
      acceptedFacts.configurationRevision = configRevision;
      stateChanged = true;
    } else {
      const before = next.providers;
      next.providers = next.providers.map(clearIdentityMigrationPending);
      if (next.providers.some((fact, i) => fact !== before[i])) stateChanged = true;
    }

    const freshIds = dedupedIds.filter(id => !hasAcceptedFact(next, 'intervention', id));
    if (freshIds.length > 0) {
      next.acceptedInterventions = appendBounded(next.acceptedInterventions, freshIds, LLM_RECOVERY_ACCEPTED_IDS_MAX);
      next.providers = next.providers.map(releaseRateLimitBlocked);
      acceptedFacts.interventionIds = freshIds;
      stateChanged = true;
    }
    const hasUserQualification = freshIds.length > 0;

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
    const acceptedBatchRevision = this.getRevision() + 1;

    if (active) {
      next.invocations = next.invocations.map(invocation => invocation.invocationId === active.invocationId
        ? {
            ...invocation,
            requestKey: input.requestKey,
            resumedFromRestart: undefined,
            interventionIds: mergeIds(invocation.interventionIds ?? [], acceptedFacts.interventionIds),
            ...(acceptedFacts.configurationRevision !== undefined
              ? { configurationRevision: acceptedFacts.configurationRevision }
              : invocation.configurationRevision !== undefined
                ? { configurationRevision: invocation.configurationRevision }
                : {}),
            ...(acceptedFacts.startupId !== undefined
              ? { startupId: acceptedFacts.startupId }
              : invocation.startupId !== undefined ? { startupId: invocation.startupId } : {}),
            allowBreakerProbe: (invocation.allowBreakerProbe ?? false) || hasUserQualification || hasStartupQualification,
          }
        : invocation);
      if (hasNewFacts) {
        next.acceptedFactBatches = appendFactBatch(next, acceptedFacts, active.attemptId, active.invocationId, acceptedBatchRevision);
      }
      const revision = this.commitNext(next, 'begin');
      if (hasNewFacts) this.emitFactsAccepted(revision, acceptedFacts, active.attemptId, active.invocationId);
      this.emit({
        type: 'recovery_attempt_admitted',
        orchestratorInstance: this.instanceId,
        invocationId: active.invocationId,
        revision,
        attemptId: active.attemptId,
        trigger: 'resumed',
        interventionCount: acceptedFacts.interventionIds.length,
      });
      return { kind: 'admitted', invocationId: active.invocationId, attemptId: active.attemptId, factsAccepted: true };
    }

    const schedule = deriveLLMRecoverySchedule(this.getProviders(), this.getRevision(), this.orchestrator.getProviderIdentities());
    let admitted = false;
    if (schedule.kind === 'ready') admitted = true;
    else if (schedule.kind === 'at') admitted = nowMs >= Date.parse(schedule.resumeAt) || hasUserQualification || hasStartupQualification;
    else admitted = hasUserQualification || hasStartupQualification;

    if (!admitted) {
      if (!stateChanged) return { kind: 'waiting', schedule: entrySchedule, factsAccepted: true };
      if (hasNewFacts) next.acceptedFactBatches = appendFactBatch(next, acceptedFacts, undefined, undefined, acceptedBatchRevision);
      const revision = this.commitNext(next, 'begin');
      if (hasNewFacts) this.emitFactsAccepted(revision, acceptedFacts, undefined, undefined);
      return { kind: 'waiting', schedule: deriveLLMRecoverySchedule(this.getProviders(), revision, this.orchestrator.getProviderIdentities()), factsAccepted: true };
    }

    const invocationId = `inv-${newUuid()}`;
    const attemptId = `att-${newUuid()}`;
    const probeOnly = entrySchedule.kind !== 'ready';
    const allowBreakerProbe = hasUserQualification || hasStartupQualification;
    const summary = summarizeAdmission(acceptedFacts, { user: hasUserQualification, startup: hasStartupQualification });
    next.invocations.push({
      invocationId,
      attemptId,
      started: false,
      requestKey: input.requestKey,
      triggerKind: summary.kind,
      ...(summary.id !== undefined ? { triggerId: summary.id } : {}),
      interventionIds: [...acceptedFacts.interventionIds],
      ...(acceptedFacts.configurationRevision !== undefined ? { configurationRevision: acceptedFacts.configurationRevision } : {}),
      ...(acceptedFacts.startupId !== undefined ? { startupId: acceptedFacts.startupId } : {}),
      probeOnly,
      allowBreakerProbe,
    });
    if (hasNewFacts) next.acceptedFactBatches = appendFactBatch(next, acceptedFacts, attemptId, invocationId, acceptedBatchRevision);
    const revision = this.commitNext(next, 'begin');
    if (hasNewFacts) this.emitFactsAccepted(revision, acceptedFacts, attemptId, invocationId);
    this.emit({
      type: 'recovery_attempt_admitted',
      orchestratorInstance: this.instanceId,
      invocationId,
      revision,
      attemptId,
      trigger: summary.kind,
      interventionCount: acceptedFacts.interventionIds.length,
    });
    return { kind: 'admitted', invocationId, attemptId, factsAccepted: true };
  }

  async finish(
    invocationId: string,
    attemptId: string,
    outcome: 'completed' | 'interrupted' | 'failed',
  ): Promise<void> {
    const state = this.getState();
    const active = state.invocations.find(invocation => invocation.invocationId === invocationId && invocation.attemptId === attemptId);
    if (!active) {
      this.emit({
        type: 'recovery_attempt_finished', orchestratorInstance: this.instanceId, invocationId,
        revision: this.getRevision(), attemptId, outcome, accepted: false,
      });
      return;
    }
    const next = cloneRecovery(state);
    next.invocations = next.invocations.filter(invocation => invocation.invocationId !== invocationId);
    const revision = this.commitNext(next, 'finish');
    this.emit({
      type: 'recovery_attempt_finished', orchestratorInstance: this.instanceId, invocationId,
      revision, attemptId, outcome, accepted: true,
    });
  }

  attemptContext(invocationId: string): { probeOnly: boolean; allowBreakerProbe: boolean; attemptId: string } {
    const active = this.getState().invocations.find(invocation => invocation.invocationId === invocationId);
    if (!active) throw new Error(`unknown recovery invocation ${invocationId}`);
    return {
      probeOnly: active.probeOnly ?? false,
      allowBreakerProbe: active.allowBreakerProbe ?? false,
      attemptId: active.attemptId,
    };
  }

  noteAttemptStarted(invocationId: string): void {
    const state = this.getState();
    const active = state.invocations.find(invocation => invocation.invocationId === invocationId);
    if (!active || active.started) return;
    const next = cloneRecovery(state);
    next.invocations = next.invocations.map(invocation => invocation.invocationId === invocationId
      ? { ...invocation, started: true, startedAt: new Date(this.now()).toISOString() }
      : invocation);
    this.commitNext(next, 'noteAttemptStarted');
  }

  noteSuccess(invocationId: string, _winnerProviderId: string): void {
    const active = this.getState().invocations.find(invocation => invocation.invocationId === invocationId);
    const revision = this.getRevision();
    const schedule = deriveLLMRecoverySchedule(this.getProviders(), revision, this.orchestrator.getProviderIdentities());
    if (schedule.kind === 'ready') {
      this.emit({
        type: 'recovery_ready', orchestratorInstance: this.instanceId, invocationId,
        ...(active ? { attemptId: active.attemptId } : {}), revision, reason: 'success',
      });
    }
  }

  noteFailure(failures: readonly RecoveryFailureInput[]): void {
    const realFailures = failures.filter(failure => failure.localSkip !== true
      && failure.errorClass !== 'abort' && failure.errorClass !== 'context_exceeded');
    if (realFailures.length === 0) return;
    const next = cloneRecovery(this.getState());
    const providers = this.getProviders().map(provider => ({ ...provider }));
    let lastErrorClass = 'unknown';

    for (const failure of realFailures) {
      lastErrorClass = failure.errorClass;
      const nowMs = failure.occurredAtMs ?? this.now();
      const nowIso = new Date(nowMs).toISOString();
      const index = providers.findIndex(provider => provider.providerId === failure.providerId);
      const previous: LLMProviderRecoveryState = index >= 0
        ? providers[index]!
        : { providerId: failure.providerId, status: 'available' };
      const consecutiveFailures = (previous.consecutiveFailures ?? 0) + 1;
      const nextProvider: LLMProviderRecoveryState = {
        ...previous,
        status: 'waiting',
        retryAt: retryAtForFailure(previous, failure, nowMs, consecutiveFailures),
        consecutiveFailures,
        lastError: {
          class: failure.errorClass,
          at: nowMs,
          message: failure.message,
          ...(failure.providerLabel !== undefined ? { providerLabel: failure.providerLabel } : {}),
          ...(failure.retryAfterSec !== undefined ? { retryAfterSec: failure.retryAfterSec } : {}),
          ...(failure.resetAtMs !== undefined ? { quotaResetAtMs: failure.resetAtMs } : {}),
        },
      };
      if (index >= 0) providers[index] = nextProvider;
      else providers.push(nextProvider);
      this.pushFailure(next, {
        at: nowIso,
        providerId: failure.providerId,
        errorClass: failure.errorClass,
        message: failure.message,
        ...(failure.providerLabel !== undefined ? { providerLabel: failure.providerLabel } : {}),
        ...(failure.invocationId !== undefined ? { invocationId: failure.invocationId } : {}),
        ...(failure.attemptId !== undefined ? { attemptId: failure.attemptId } : {}),
        ...(failure.attemptIndex !== undefined ? { attemptIndex: failure.attemptIndex } : {}),
        ...(failure.configRevision !== undefined ? { configRevision: failure.configRevision } : {}),
      });
    }

    const first = realFailures[0];
    const revision = this.commitNext(next, 'noteFailure', providers);
    const schedule = deriveLLMRecoverySchedule(providers, revision, this.orchestrator.getProviderIdentities());
    this.emit({
      type: 'recovery_scheduled', orchestratorInstance: this.instanceId,
      ...(first?.invocationId !== undefined ? { invocationId: first.invocationId } : {}),
      ...(first?.attemptId !== undefined ? { attemptId: first.attemptId } : {}),
      revision,
      scheduleKind: schedule.kind === 'at' ? 'at' : 'on_change',
      resumeAt: schedule.kind === 'at' ? schedule.resumeAt : '',
      errorClass: lastErrorClass,
      providerCount: providers.length,
      failureCount: next.failures.length,
    });
  }


  private pushFailure(state: LLMInstanceRecoveryState, evidence: LLMRecoveryFailureEvidence): void {
    state.failures.push(evidence);
    if (state.failures.length > LLM_RECOVERY_FAILURE_EVIDENCE_MAX) {
      const droppedCount = state.failures.length - LLM_RECOVERY_FAILURE_EVIDENCE_MAX;
      const dropped = state.failures.slice(0, droppedCount);
      state.failures = state.failures.slice(droppedCount);
      const previous = state.failureEvidenceLoss;
      const firstDroppedAt = previous?.firstDroppedAt ?? dropped[0]?.at;
      const lastDroppedAt = dropped.at(-1)?.at ?? previous?.lastDroppedAt;
      state.failureEvidenceLoss = {
        droppedCount: (previous?.droppedCount ?? 0) + dropped.length,
        ...(firstDroppedAt !== undefined ? { firstDroppedAt } : {}),
        ...(lastDroppedAt !== undefined ? { lastDroppedAt } : {}),
        reason: 'bounded_retention',
        policyVersion: LLM_RECOVERY_FAILURE_EVIDENCE_POLICY_VERSION,
        recoverability: 'not_preserved_in_recovery_state',
      };
    }
  }

  private commitNext(
    next: LLMInstanceRecoveryState,
    context: string,
    providers?: readonly LLMProviderRecoveryState[],
  ): number {
    try {
      return this.commit(next, context, providers);
    } catch (error) {
      this.emit({
        type: 'recovery_state_write_failed', orchestratorInstance: this.instanceId,
        reason: formatErr(error), context,
      });
      throw error;
    }
  }

  private emitFactsAccepted(
    revision: number,
    accepted: AcceptedFacts,
    attemptId: string | undefined,
    invocationId: string | undefined,
  ): void {
    this.emit({
      type: 'recovery_facts_accepted', orchestratorInstance: this.instanceId, revision,
      ...(invocationId !== undefined ? { invocationId } : {}),
      interventionIds: [...accepted.interventionIds],
      ...(accepted.configurationRevision !== undefined ? { configurationRevision: accepted.configurationRevision } : {}),
      ...(accepted.startupId !== undefined ? { startupId: accepted.startupId } : {}),
      ...(attemptId !== undefined ? { attemptId } : {}),
    });
  }

  private emit(event: Parameters<LLMEventSink['emit']>[0]): void {
    this.events.emit(event);
  }
}

function appendFactBatch(
  next: LLMInstanceRecoveryState,
  accepted: AcceptedFacts,
  attemptId: string | undefined,
  invocationId: string | undefined,
  revision: number,
): LLMInstanceAcceptedFactBatch[] {
  return [...(next.acceptedFactBatches ?? []), {
    revision,
    interventionIds: [...accepted.interventionIds],
    ...(accepted.configurationRevision !== undefined ? { configurationRevision: accepted.configurationRevision } : {}),
    ...(accepted.startupId !== undefined ? { startupId: accepted.startupId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(invocationId !== undefined ? { invocationId } : {}),
  }];
}

function summarizeAdmission(
  accepted: AcceptedFacts,
  qualifications: { user: boolean; startup: boolean },
): { kind: string; id?: string } {
  if (qualifications.user) return { kind: 'intervention' };
  if (qualifications.startup) return accepted.startupId !== undefined
    ? { kind: 'startup', id: accepted.startupId }
    : { kind: 'startup' };
  if (accepted.configurationRevision !== undefined) return { kind: 'configuration', id: accepted.configurationRevision };
  return { kind: 'automatic' };
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

function retryAtForFailure(
  _previous: LLMProviderRecoveryState,
  failure: RecoveryFailureInput,
  nowMs: number,
  consecutiveFailures: number,
): number {
  const retryAfterAtMs = failure.retryAfterSec !== undefined
    ? nowMs + failure.retryAfterSec * 1000
    : 0;
  if (failure.errorClass === 'quota') {
    const delayMs = Math.min(
      LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1),
      LLM_RECOVERY_QUOTA_MAX_DELAY_MS,
    );
    return Math.max(nowMs + delayMs, retryAfterAtMs, failure.resetAtMs ?? 0);
  }
  if (failure.errorClass === 'rate_limit') {
    if (retryAfterAtMs > 0) return retryAfterAtMs;
    const index = Math.min(Math.max(0, consecutiveFailures - 1), LLM_RECOVERY_RATE_LIMIT_BACKOFF_MS.length - 1);
    return nowMs + LLM_RECOVERY_RATE_LIMIT_BACKOFF_MS[index]!;
  }
  if (failure.errorClass === 'permanent') return nowMs + LLM_RECOVERY_COOLDOWN_MS;
  const delayMs = Math.min(
    LLM_RECOVERY_RETRY_INITIAL_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    LLM_RECOVERY_RETRY_MAX_DELAY_MS,
  );
  return nowMs + delayMs;
}

function clearIdentityMigrationPending(fact: LLMInstanceRecoveryProviderFact): LLMInstanceRecoveryProviderFact {
  if (fact.identityMigrationPending === undefined) return fact;
  const { identityMigrationPending: _pending, ...rest } = fact;
  return rest;
}

function releaseRateLimitBlocked(fact: LLMInstanceRecoveryProviderFact): LLMInstanceRecoveryProviderFact {
  if (fact.rateLimitBlocked !== true) return fact;
  const { rateLimitBlocked: _blocked, rateLimitBlockedAt: _blockedAt, ...rest } = fact;
  return { ...rest, rateLimitFailures: 0 };
}

/** 只由实际 LLM 请求语义派生身份；恢复事实、超时与 AbortSignal 不参与。 */
export function requestKeyForCall(options: LLMCallOptions): string {
  const canonical = canonicalizeForRequestKey({
    messages: options.messages,
    system: options.system,
    tools: options.tools,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    model: options.model,
  });
  return sha256ShortHex(JSON.stringify(canonical), 24);
}

function canonicalizeForRequestKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForRequestKey);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) result[key] = canonicalizeForRequestKey(item);
  }
  return result;
}
