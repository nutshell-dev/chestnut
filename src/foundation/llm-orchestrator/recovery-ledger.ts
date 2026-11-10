/**
 * 窄依赖 RecoveryLedger：只处理 provider 恢复事实、invocation 和失败证据。
 * 文件读写由 InstanceStateStore 提交接口隔离；本模块不引用 orchestrator 或宽 owner。
 */
import { formatErr, newUuid } from '../node-utils/index.js';
import type { LLMEvent, LLMRecoveryFacts } from './types.js';
import type { LLMErrorClass } from './errors.js';
import type { ProviderAdmission } from './provider-admission.js';
import type { InstanceStateStore } from './instance-state-store.js';
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

export type LLMRecoveryAdmission =
  | { kind: 'admitted'; invocationId: string; attemptId: string; factsAccepted: true }
  | { kind: 'waiting'; schedule: LLMRecoverySchedule; factsAccepted: boolean };

export interface RecoveryLedgerSnapshot {
  readonly instanceId: string;
  readonly recovery: LLMInstanceRecoveryState;
  readonly revision: number;
  readonly providers: readonly LLMProviderRecoveryState[];
}

export interface RecoveryLedgerDeps {
  store: InstanceStateStore;
  providerIds: readonly string[];
  legacyProviderIds: readonly string[];
  emit(event: LLMEvent): void;
  admission: ProviderAdmission;
  now?: () => number;
}

export interface RecoveryLedger {
  snapshot(): RecoveryLedgerSnapshot;
  canProbe(providerId: string, nowMs: number): boolean;
  subscribeCommits(listener: (context: string) => void): () => void;
  noteProviderSuccess(providerId: string, nowMs: number, updateSelection: boolean): void;
  noteAttemptStarted(invocationId: string): void;
  attemptContext(invocationId: string): { probeOnly: boolean; allowBreakerProbe: boolean; attemptId: string };
  noteSuccess(invocationId: string, winnerProviderId: string): void;
  inspect(): Promise<LLMRecoverySchedule>;
  begin(input: { requestKey: string; facts: LLMRecoveryFacts }): Promise<LLMRecoveryAdmission>;
  finish(
    invocationId: string,
    attemptId: string,
    outcome: 'completed' | 'interrupted' | 'failed',
  ): Promise<void>;
  noteFailure(failures: readonly RecoveryFailureInput[]): void;
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

export class LLMRecoveryControllerImpl implements RecoveryLedger {
  private readonly instanceId: string;
  private providerIds: readonly string[];
  private legacyProviderIds: readonly string[];
  private readonly store: InstanceStateStore;
  private readonly commitListeners = new Set<(context: string) => void>();
  private readonly emitEvent: RecoveryLedgerDeps['emit'];
  private readonly admission: ProviderAdmission;
  private readonly now: () => number;

  constructor(deps: RecoveryLedgerDeps) {
    this.instanceId = deps.store.snapshot().instanceId;
    this.providerIds = [...deps.providerIds];
    this.legacyProviderIds = [...deps.legacyProviderIds];
    this.store = deps.store;
    this.emitEvent = deps.emit;
    this.admission = deps.admission;
    this.now = deps.now ?? Date.now;
    // 构造顺序是持久协议：先身份迁移，再把重启后的在途 invocation 记账。
    this.migrateProviderIdentities();
    this.recoverInvocationsAfterRestart();
  }

  snapshot(): RecoveryLedgerSnapshot {
    return this.store.snapshot();
  }

  canProbe(providerId: string, nowMs: number): boolean {
    const state = this.getProviders().find(provider => provider.providerId === providerId);
    return state === undefined || this.admission.canProbe(state, nowMs);
  }

  subscribeCommits(listener: (context: string) => void): () => void {
    this.commitListeners.add(listener);
    return () => { this.commitListeners.delete(listener); };
  }

  /** Persist the next identity filter before either Runtime or this view switches. */
  reloadProviderIdentities(providerIds: readonly string[], legacyProviderIds: readonly string[]): void {
    const current = new Set(providerIds);
    const providers = this.getProviders()
      .filter(provider => current.has(provider.providerId))
      .map(provider => {
        const { lastSuccessAt: _lastSuccessAt, cacheValidUntil: _cacheValidUntil, ...retained } = provider;
        return retained;
      });
    const result = this.store.commit('reload_config', {
      providers: [...providers],
      recovery: this.getState(),
    }, { providerIds, force: true });
    if (result.kind === 'failed') {
      throw new Error('LLM instance state persistence failed during reloadConfig', { cause: result.error });
    }
    this.providerIds = [...providerIds];
    this.legacyProviderIds = [...legacyProviderIds];
  }

  private getState(): LLMInstanceRecoveryState {
    return this.store.snapshot().recovery;
  }

  private getRevision(): number {
    return this.store.snapshot().revision;
  }

  private getProviders(): readonly LLMProviderRecoveryState[] {
    return this.store.snapshot().providers;
  }

  async inspect(): Promise<LLMRecoverySchedule> {
    return deriveLLMRecoverySchedule(this.getProviders(), this.getRevision(), this.providerIds);
  }

  private migrateProviderIdentities(): void {
    const legacyToCurrent = new Map<string, string>();
    const currentIds = this.providerIds;
    const legacyIds = this.legacyProviderIds;
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
    const entrySchedule = deriveLLMRecoverySchedule(this.getProviders(), this.getRevision(), this.providerIds);
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
      const currentIds = new Set(this.providerIds);
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

    const schedule = deriveLLMRecoverySchedule(this.getProviders(), this.getRevision(), this.providerIds);
    let admitted = false;
    if (schedule.kind === 'ready') admitted = true;
    else if (schedule.kind === 'at') admitted = nowMs >= Date.parse(schedule.resumeAt) || hasUserQualification || hasStartupQualification;
    else admitted = hasUserQualification || hasStartupQualification;

    if (!admitted) {
      if (!stateChanged) return { kind: 'waiting', schedule: entrySchedule, factsAccepted: true };
      if (hasNewFacts) next.acceptedFactBatches = appendFactBatch(next, acceptedFacts, undefined, undefined, acceptedBatchRevision);
      const revision = this.commitNext(next, 'begin');
      if (hasNewFacts) this.emitFactsAccepted(revision, acceptedFacts, undefined, undefined);
      return { kind: 'waiting', schedule: deriveLLMRecoverySchedule(this.getProviders(), revision, this.providerIds), factsAccepted: true };
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

  noteProviderSuccess(providerId: string, nowMs: number, updateSelection: boolean): void {
    const providers = this.getProviders().map(provider => ({ ...provider }));
    const index = providers.findIndex(provider => provider.providerId === providerId);
    const previous: LLMProviderRecoveryState = index >= 0
      ? providers[index]!
      : { providerId, status: 'available' };
    const next = this.admission.recordSuccess(previous, { nowMs, updateSelection });
    if (index >= 0) providers[index] = next;
    else providers.push(next);
    const context = updateSelection ? 'provider_success' : 'probe_provider_health_clear';
    const result = this.store.commit(context, {
      providers,
      recovery: this.getState(),
    }, { providerIds: this.providerIds });
    if (result.kind === 'failed') {
      throw new Error('LLM instance state persistence failed during provider success', { cause: result.error });
    }
    if (updateSelection) this.notifyCommit(context);
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
    const schedule = deriveLLMRecoverySchedule(this.getProviders(), revision, this.providerIds);
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
      const nextProvider = this.admission.recordFailure(previous, {
        errorClass: failure.errorClass,
        message: failure.message,
        occurredAtMs: nowMs,
        ...(failure.providerLabel !== undefined ? { providerLabel: failure.providerLabel } : {}),
        ...(failure.retryAfterSec !== undefined ? { retryAfterSec: failure.retryAfterSec } : {}),
        ...(failure.resetAtMs !== undefined ? { resetAtMs: failure.resetAtMs } : {}),
      });
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
    const schedule = deriveLLMRecoverySchedule(providers, revision, this.providerIds);
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
    this.notifyCommit('noteFailure');
  }

  private notifyCommit(context: string): void {
    for (const listener of this.commitListeners) listener(context);
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
      const result = this.store.commit(context, {
        providers: [...(providers ?? this.getProviders())],
        recovery: next,
      }, { providerIds: this.providerIds });
      if (result.kind === 'failed') {
        throw new Error(`LLM instance state persistence failed during ${context}`, { cause: result.error });
      }
      return result.revision;
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

  private emit(event: LLMEvent): void {
    this.emitEvent(event);
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

