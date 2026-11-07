/**
 * LLMOrchestrator 实例的唯一持久事实：健康、选择基础、恢复历史与在途 invocation。
 * 旧 recovery/retry 文件只由 InstanceStateStore 构造期只读导入；原子写入由 Store 调用本文件。
 */
import * as path from 'path';
import { formatErr, newUuid } from '../node-utils/index.js';
import { isFileNotFound, type FileSystem } from '../fs/index.js';
import type { LLMErrorClass } from './errors.js';
import {
  LLM_RECOVERY_FAILURE_EVIDENCE_POLICY_VERSION,
  type LLMRecoveryAcceptedFactBatch,
  type LLMRecoveryAdmissionRecord,
  type LLMRecoveryBudget,
  type LLMRecoveryFailureEvidence,
  type LLMRecoveryFailureEvidenceLoss,
  type LLMRecoveryProviderFact,
  type LLMRecoveryStateV1,
} from './recovery-state.js';
import {
  LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
} from './defaults.js';

export const LLM_INSTANCE_STATE_FILE = 'llm-instance-state.json' as const;

export interface LLMInstanceBreakerState {
  state: 'closed' | 'open';
  consecutiveFailures: number;
  openedAtMs?: number;
  lastFailureClass: LLMErrorClass | null;
}

export interface LLMInstanceSharedFailure {
  errorClass: LLMErrorClass;
  floorMs?: number;
}

export interface LLMInstanceProviderState {
  providerId: string;
  breaker: LLMInstanceBreakerState;
  sharedFailure?: LLMInstanceSharedFailure;
}

export interface LLMInstanceStateV1 {
  schema_version: 1;
  revision: number;
  updatedAt: string;
  providers: LLMInstanceProviderState[];
  lastSuccess: { providerId: string } | null;
}

export interface LLMInstanceRecoveryProviderFact extends LLMRecoveryProviderFact {
  /** 是否仍阻断新 admission；false 保留历史健康事实但不再派生等待。 */
  blocking: boolean;
  /** 本 provider 健康事实派生的最早可试时刻；schedule 不另行持久化。 */
  retryAt?: string;
}

export type LLMInstanceAcceptedFactBatch = Omit<LLMRecoveryAcceptedFactBatch, 'scope'> & {
  invocationId?: string;
};

export type LLMInstanceInvocation = Omit<LLMRecoveryAdmissionRecord, 'admissionKind'> & {
  invocationId: string;
};

export interface LLMInstanceRecoveryState {
  budget: LLMRecoveryBudget;
  providers: LLMInstanceRecoveryProviderFact[];
  acceptedInterventions: string[];
  acceptedConfigRevisions: string[];
  lastStartupProbeId?: string;
  invocations: LLMInstanceInvocation[];
  failures: LLMRecoveryFailureEvidence[];
  failureEvidenceLoss?: LLMRecoveryFailureEvidenceLoss;
  importedSources: string[];
  acceptedFactBatches?: LLMInstanceAcceptedFactBatch[];
}

export interface LLMInstanceStateV2 {
  schema_version: 2;
  instanceId: string;
  revision: number;
  updatedAt: string;
  providers: LLMInstanceProviderState[];
  /** 旧 V2 可能只有 providerId；缺少时间的记录只作历史事实，不续期为有效缓存。 */
  lastSuccess: { providerId: string; lastUsedAt?: number; cacheValidUntil?: number } | null;
  recovery: LLMInstanceRecoveryState;
}

/** 每个 provider 唯一的运行期恢复事实；恢复历史仍留在 recovery 中供审计。 */
export interface LLMProviderRecoveryState {
  providerId: string;
  status: 'available' | 'waiting';
  /** 最早可持续探测时刻（epoch ms）。 */
  retryAt?: number;
  lastError?: {
    class: LLMErrorClass;
    at: number;
    message: string;
    providerLabel?: string;
    retryAfterSec?: number;
    quotaResetAtMs?: number;
    migrationSources?: string[];
  };
  lastSuccessAt?: number;
  cacheValidUntil?: number;
  consecutiveFailures?: number;
}

export interface LLMInstanceStateV3 {
  schema_version: 3;
  instanceId: string;
  revision: number;
  updatedAt: string;
  providers: LLMProviderRecoveryState[];
  recovery: LLMInstanceRecoveryState;
}

export type LLMInstanceStateLoad =
  | { kind: 'missing' }
  | { kind: 'ok'; state: LLMInstanceStateV3 }
  | { kind: 'legacy'; state: LLMInstanceStateV1 | LLMInstanceStateV2 }
  | { kind: 'unusable'; reason: 'read_failed' | 'parse_failed' | 'schema_invalid'; detail: string };

const ERROR_CLASSES = new Set<LLMErrorClass>([
  'permanent', 'transient', 'rate_limit', 'abort', 'context_exceeded', 'quota', 'unknown',
]);

function instanceStatePath(stateDir = 'status'): string {
  return path.join(stateDir, LLM_INSTANCE_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isErrorClass(value: unknown): value is LLMErrorClass {
  return typeof value === 'string' && ERROR_CLASSES.has(value as LLMErrorClass);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function validateBreaker(value: unknown): value is LLMInstanceBreakerState {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state', 'consecutiveFailures', 'openedAtMs', 'lastFailureClass'])) return false;
  if (value.state !== 'closed' && value.state !== 'open') return false;
  if (!isNonNegativeInteger(value.consecutiveFailures)) return false;
  if (value.lastFailureClass !== null && !isErrorClass(value.lastFailureClass)) return false;
  if (value.openedAtMs !== undefined && !isNonNegativeNumber(value.openedAtMs)) return false;
  return value.state === 'open' ? value.openedAtMs !== undefined : value.openedAtMs === undefined;
}

function validateSharedFailure(value: unknown): value is LLMInstanceSharedFailure {
  return isRecord(value)
    && hasOnlyKeys(value, ['errorClass', 'floorMs'])
    && isErrorClass(value.errorClass)
    && (value.floorMs === undefined || isNonNegativeNumber(value.floorMs));
}

function validateProviders(value: unknown): value is LLMInstanceProviderState[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const provider of value) {
    if (!isRecord(provider) || !hasOnlyKeys(provider, ['providerId', 'breaker', 'sharedFailure'])) return false;
    if (typeof provider.providerId !== 'string' || provider.providerId.length === 0 || ids.has(provider.providerId)) return false;
    if (!validateBreaker(provider.breaker)) return false;
    if (provider.sharedFailure !== undefined && !validateSharedFailure(provider.sharedFailure)) return false;
    ids.add(provider.providerId);
  }
  return true;
}

function validateBudget(value: unknown): value is LLMRecoveryBudget {
  return isRecord(value)
    && hasOnlyKeys(value, ['retryCount', 'retryDelayMs', 'quotaDelayMs'])
    && isNonNegativeInteger(value.retryCount)
    && isPositiveNumber(value.retryDelayMs)
    && isPositiveNumber(value.quotaDelayMs);
}

function validateRecoveryProvider(value: unknown): value is LLMInstanceRecoveryProviderFact {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'providerId', 'errorClass', 'at', 'consecutiveFailures', 'detail', 'rateLimitFailures',
    'rateLimitBlocked', 'rateLimitBlockedAt', 'providerLabel', 'identityMigrationPending',
    'blocking', 'retryAt',
  ])) return false;
  if (typeof value.providerId !== 'string' || value.providerId.length === 0) return false;
  if (typeof value.errorClass !== 'string' || !isIsoDate(value.at) || typeof value.detail !== 'string') return false;
  if (!isNonNegativeInteger(value.consecutiveFailures) || typeof value.blocking !== 'boolean') return false;
  if (value.retryAt !== undefined && !isIsoDate(value.retryAt)) return false;
  if (value.rateLimitFailures !== undefined && !isNonNegativeInteger(value.rateLimitFailures)) return false;
  if (value.rateLimitBlocked !== undefined && typeof value.rateLimitBlocked !== 'boolean') return false;
  if (value.rateLimitBlockedAt !== undefined && !isIsoDate(value.rateLimitBlockedAt)) return false;
  if (value.providerLabel !== undefined && typeof value.providerLabel !== 'string') return false;
  return value.identityMigrationPending === undefined || typeof value.identityMigrationPending === 'boolean';
}

function validateInvocation(value: unknown): value is LLMInstanceInvocation {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'invocationId', 'attemptId', 'started', 'startedAt', 'requestKey', 'triggerKind', 'triggerId',
    'interventionIds', 'configurationRevision', 'startupId', 'probeOnly', 'allowBreakerProbe',
    'resumedFromRestart',
  ])) return false;
  if (typeof value.invocationId !== 'string' || value.invocationId.length === 0) return false;
  if (typeof value.attemptId !== 'string' || value.attemptId.length === 0 || typeof value.started !== 'boolean') return false;
  if (typeof value.requestKey !== 'string' || typeof value.triggerKind !== 'string') return false;
  if (value.startedAt !== undefined && !isIsoDate(value.startedAt)) return false;
  if (value.triggerId !== undefined && typeof value.triggerId !== 'string') return false;
  if (value.interventionIds !== undefined && !isStringArray(value.interventionIds)) return false;
  if (value.configurationRevision !== undefined && typeof value.configurationRevision !== 'string') return false;
  if (value.startupId !== undefined && typeof value.startupId !== 'string') return false;
  for (const key of ['probeOnly', 'allowBreakerProbe', 'resumedFromRestart'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  }
  return true;
}

function validateFailure(value: unknown): value is LLMRecoveryFailureEvidence {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'at', 'providerId', 'errorClass', 'message', 'providerLabel', 'invocationId', 'attemptId',
    'attemptIndex', 'configRevision',
  ])) return false;
  if (!isIsoDate(value.at) || typeof value.providerId !== 'string' || typeof value.errorClass !== 'string' || typeof value.message !== 'string') return false;
  if (value.providerLabel !== undefined && typeof value.providerLabel !== 'string') return false;
  if (value.invocationId !== undefined && typeof value.invocationId !== 'string') return false;
  if (value.attemptId !== undefined && typeof value.attemptId !== 'string') return false;
  if (value.attemptIndex !== undefined && !isNonNegativeInteger(value.attemptIndex)) return false;
  return value.configRevision === undefined || isNonNegativeInteger(value.configRevision);
}

function validateLoss(value: unknown): value is LLMRecoveryFailureEvidenceLoss {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'droppedCount', 'firstDroppedAt', 'lastDroppedAt', 'reason', 'policyVersion', 'recoverability',
  ])) return false;
  if (!isNonNegativeInteger(value.droppedCount) || value.reason !== 'bounded_retention') return false;
  if (value.policyVersion !== LLM_RECOVERY_FAILURE_EVIDENCE_POLICY_VERSION || value.recoverability !== 'not_preserved_in_recovery_state') return false;
  if (value.firstDroppedAt !== undefined && !isIsoDate(value.firstDroppedAt)) return false;
  if (value.lastDroppedAt !== undefined && !isIsoDate(value.lastDroppedAt)) return false;
  return value.droppedCount === 0 || (value.firstDroppedAt !== undefined && value.lastDroppedAt !== undefined);
}

function validateAcceptedBatch(value: unknown): value is LLMInstanceAcceptedFactBatch {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'revision', 'interventionIds', 'configurationRevision', 'startupId', 'attemptId', 'invocationId',
  ])) return false;
  if (!isNonNegativeInteger(value.revision) || value.revision < 1 || !isStringArray(value.interventionIds)) return false;
  if (value.configurationRevision !== undefined && typeof value.configurationRevision !== 'string') return false;
  if (value.startupId !== undefined && typeof value.startupId !== 'string') return false;
  if (value.attemptId !== undefined && typeof value.attemptId !== 'string') return false;
  return value.invocationId === undefined || typeof value.invocationId === 'string';
}

function validateRecovery(value: unknown): value is LLMInstanceRecoveryState {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'budget', 'providers', 'acceptedInterventions', 'acceptedConfigRevisions', 'lastStartupProbeId',
    'invocations', 'failures', 'failureEvidenceLoss', 'importedSources', 'acceptedFactBatches',
  ])) return false;
  if (!validateBudget(value.budget) || !Array.isArray(value.providers) || !value.providers.every(validateRecoveryProvider)) return false;
  const providerIds = new Set<string>();
  for (const provider of value.providers) {
    if (providerIds.has(provider.providerId)) return false;
    providerIds.add(provider.providerId);
  }
  if (!isStringArray(value.acceptedInterventions) || !isStringArray(value.acceptedConfigRevisions)) return false;
  if (value.lastStartupProbeId !== undefined && typeof value.lastStartupProbeId !== 'string') return false;
  if (!Array.isArray(value.invocations) || !value.invocations.every(validateInvocation)) return false;
  const invocationIds = new Set<string>();
  for (const invocation of value.invocations) {
    if (invocationIds.has(invocation.invocationId)) return false;
    invocationIds.add(invocation.invocationId);
  }
  if (!Array.isArray(value.failures) || !value.failures.every(validateFailure)) return false;
  if (value.failureEvidenceLoss !== undefined && !validateLoss(value.failureEvidenceLoss)) return false;
  if (!isStringArray(value.importedSources)) return false;
  return value.acceptedFactBatches === undefined
    || (Array.isArray(value.acceptedFactBatches) && value.acceptedFactBatches.every(validateAcceptedBatch));
}

function validateV1(value: unknown): value is LLMInstanceStateV1 {
  if (!isRecord(value) || value.schema_version !== 1 || !isNonNegativeInteger(value.revision)) return false;
  if (!isIsoDate(value.updatedAt) || !validateProviders(value.providers)) return false;
  if (value.lastSuccess !== null) {
    if (!isRecord(value.lastSuccess) || typeof value.lastSuccess.providerId !== 'string') return false;
    const lastSuccessProviderId = value.lastSuccess.providerId;
    if (!value.providers.some(provider => provider.providerId === lastSuccessProviderId)) return false;
  }
  return true;
}

function validateV2(value: unknown): value is LLMInstanceStateV2 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schema_version', 'instanceId', 'revision', 'updatedAt', 'providers', 'lastSuccess', 'recovery',
  ])) return false;
  if (value.schema_version !== 2 || typeof value.instanceId !== 'string' || value.instanceId.length === 0) return false;
  if (!isNonNegativeInteger(value.revision) || !isIsoDate(value.updatedAt) || !validateProviders(value.providers)) return false;
  if (value.lastSuccess !== null) {
    if (!isRecord(value.lastSuccess)
      || !hasOnlyKeys(value.lastSuccess, ['providerId', 'lastUsedAt', 'cacheValidUntil'])
      || typeof value.lastSuccess.providerId !== 'string') return false;
    const hasLastUsedAt = value.lastSuccess.lastUsedAt !== undefined;
    const hasCacheValidUntil = value.lastSuccess.cacheValidUntil !== undefined;
    if (hasLastUsedAt !== hasCacheValidUntil) return false;
    if (hasLastUsedAt && !isNonNegativeNumber(value.lastSuccess.lastUsedAt)) return false;
    if (hasCacheValidUntil && !isNonNegativeNumber(value.lastSuccess.cacheValidUntil)) return false;
    const lastSuccessProviderId = value.lastSuccess.providerId;
    if (!value.providers.some(provider => provider.providerId === lastSuccessProviderId)) return false;
  }
  if (!validateRecovery(value.recovery)) return false;
  const revision = value.revision;
  return value.recovery.acceptedFactBatches?.every(batch => batch.revision <= revision) ?? true;
}

function validateLastError(value: unknown): value is NonNullable<LLMProviderRecoveryState['lastError']> {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'class', 'at', 'message', 'providerLabel', 'retryAfterSec', 'quotaResetAtMs', 'migrationSources',
  ])) return false;
  if (!isErrorClass(value.class) || !isNonNegativeNumber(value.at) || typeof value.message !== 'string') return false;
  if (value.providerLabel !== undefined && typeof value.providerLabel !== 'string') return false;
  if (value.retryAfterSec !== undefined && !isNonNegativeNumber(value.retryAfterSec)) return false;
  if (value.quotaResetAtMs !== undefined && !isNonNegativeNumber(value.quotaResetAtMs)) return false;
  return value.migrationSources === undefined || isStringArray(value.migrationSources);
}

function validateRecoveryProviders(value: unknown): value is LLMProviderRecoveryState[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const provider of value) {
    if (!isRecord(provider) || !hasOnlyKeys(provider, [
      'providerId', 'status', 'retryAt', 'lastError', 'lastSuccessAt', 'cacheValidUntil', 'consecutiveFailures',
    ])) return false;
    if (typeof provider.providerId !== 'string' || provider.providerId.length === 0 || ids.has(provider.providerId)) return false;
    if (provider.status !== 'available' && provider.status !== 'waiting') return false;
    if (provider.retryAt !== undefined && !isNonNegativeNumber(provider.retryAt)) return false;
    if (provider.status === 'waiting' ? provider.retryAt === undefined : provider.retryAt !== undefined) return false;
    if (provider.lastError !== undefined && !validateLastError(provider.lastError)) return false;
    const lastSuccessAt = provider.lastSuccessAt;
    const cacheValidUntil = provider.cacheValidUntil;
    if ((lastSuccessAt === undefined) !== (cacheValidUntil === undefined)) return false;
    if (lastSuccessAt !== undefined && cacheValidUntil !== undefined) {
      if (!isNonNegativeNumber(lastSuccessAt) || !isNonNegativeNumber(cacheValidUntil)) return false;
      if (cacheValidUntil < lastSuccessAt) return false;
    }
    if (provider.consecutiveFailures !== undefined && !isNonNegativeInteger(provider.consecutiveFailures)) return false;
    ids.add(provider.providerId);
  }
  return true;
}

function validateV3(value: unknown): value is LLMInstanceStateV3 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schema_version', 'instanceId', 'revision', 'updatedAt', 'providers', 'recovery',
  ])) return false;
  if (value.schema_version !== 3 || typeof value.instanceId !== 'string' || value.instanceId.length === 0) return false;
  if (!isNonNegativeInteger(value.revision) || !isIsoDate(value.updatedAt) || !validateRecoveryProviders(value.providers)) return false;
  if (!validateRecovery(value.recovery)) return false;
  const revision = value.revision;
  return value.recovery.acceptedFactBatches?.every(batch => batch.revision <= revision) ?? true;
}

export function createEmptyLLMInstanceRecoveryState(): LLMInstanceRecoveryState {
  return {
    budget: {
      retryCount: 0,
      retryDelayMs: LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
      quotaDelayMs: LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
    },
    providers: [],
    acceptedInterventions: [],
    acceptedConfigRevisions: [],
    invocations: [],
    failures: [],
    importedSources: [],
  };
}

export function createEmptyLLMInstanceState(instanceId = `llm-${newUuid()}`): LLMInstanceStateV3 {
  return {
    schema_version: 3,
    instanceId,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    providers: [],
    recovery: createEmptyLLMInstanceRecoveryState(),
  };
}

const LEGACY_WAITING_RETRY_DELAY_MS = 300_000;

function cloneRecoveryState(source: LLMInstanceRecoveryState): LLMInstanceRecoveryState {
  return {
    budget: { ...source.budget },
    providers: source.providers.map(provider => ({ ...provider })),
    acceptedInterventions: [...source.acceptedInterventions],
    acceptedConfigRevisions: [...source.acceptedConfigRevisions],
    ...(source.lastStartupProbeId !== undefined ? { lastStartupProbeId: source.lastStartupProbeId } : {}),
    invocations: source.invocations.map(invocation => ({
      ...invocation,
      ...(invocation.interventionIds !== undefined ? { interventionIds: [...invocation.interventionIds] } : {}),
    })),
    failures: source.failures.map(failure => ({ ...failure })),
    ...(source.failureEvidenceLoss !== undefined ? { failureEvidenceLoss: { ...source.failureEvidenceLoss } } : {}),
    importedSources: [...source.importedSources],
    ...(source.acceptedFactBatches !== undefined ? {
      acceptedFactBatches: source.acceptedFactBatches.map(batch => ({
        ...batch,
        interventionIds: [...batch.interventionIds],
      })),
    } : {}),
  };
}

function importLegacyRecovery(
  legacy: LLMRecoveryStateV1,
  currentProviderIds: readonly string[],
  legacyProviderIds: readonly string[],
): LLMInstanceRecoveryState {
  if (legacy.schedule.kind !== 'ready' && legacy.providers.length === 0) {
    throw new Error('legacy recovery wait has no provider health fact to map');
  }
  const ids = new Set<string>();
  for (const fact of legacy.providers) {
    if (ids.has(fact.providerId)) throw new Error(`duplicate legacy recovery provider ${fact.providerId}`);
    ids.add(fact.providerId);
  }
  if (legacy.schedule.kind !== 'ready') {
    for (let i = 0; i < currentProviderIds.length; i++) {
      const currentId = currentProviderIds[i];
      const legacyId = legacyProviderIds[i];
      if (currentId !== undefined && !ids.has(currentId) && (legacyId === undefined || !ids.has(legacyId))) {
        throw new Error(`legacy recovery wait has no health fact for current provider ${currentId}`);
      }
    }
  }
  const recovery = createEmptyLLMInstanceRecoveryState();
  recovery.budget = { ...legacy.budget };
  recovery.providers = legacy.providers.map(fact => ({
    ...fact,
    blocking: legacy.schedule.kind !== 'ready',
    ...(legacy.schedule.kind === 'at' ? { retryAt: legacy.schedule.resumeAt } : {}),
  }));
  recovery.acceptedInterventions = [...legacy.acceptedInterventions];
  recovery.acceptedConfigRevisions = [...legacy.acceptedConfigRevisions];
  if (legacy.lastStartupProbeId !== undefined) recovery.lastStartupProbeId = legacy.lastStartupProbeId;
  recovery.failures = legacy.failures.map(failure => ({ ...failure }));
  if (legacy.failureEvidenceLoss) recovery.failureEvidenceLoss = { ...legacy.failureEvidenceLoss };
  recovery.importedSources = legacy.importedSources.length > 0
    ? [...legacy.importedSources]
    : ['status/llm-recovery-state.json#schema_version=1'];
  recovery.acceptedFactBatches = (legacy.acceptedFactBatches ?? []).map(({ scope: _scope, ...batch }) => ({
    ...batch,
    interventionIds: [...batch.interventionIds],
  }));
  if (legacy.activeAdmission) {
    if (legacy.activeAdmission.admissionKind !== 'invocation') {
      throw new Error('legacy turn admission cannot be mapped to an invocation losslessly');
    }
    const { admissionKind: _kind, ...admission } = legacy.activeAdmission;
    recovery.invocations = [{
      ...admission,
      ...(admission.interventionIds !== undefined ? { interventionIds: [...admission.interventionIds] } : {}),
      invocationId: `legacy-invocation-${admission.attemptId}`,
    }];
  }
  return recovery;
}

function assertUniqueProviders(
  providers: readonly { providerId: string }[],
  source: string,
): void {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.providerId)) throw new Error(`duplicate ${source} provider ${provider.providerId}`);
    ids.add(provider.providerId);
  }
}

function migrateProviderStates(
  health: LLMInstanceStateV1 | LLMInstanceStateV2 | undefined,
  recovery: LLMInstanceRecoveryState,
  nowMs: number,
): LLMProviderRecoveryState[] {
  const healthProviders = health?.providers ?? [];
  assertUniqueProviders(healthProviders, 'instance health');
  assertUniqueProviders(recovery.providers, 'instance recovery');
  const healthById = new Map(healthProviders.map(provider => [provider.providerId, provider]));
  const factById = new Map(recovery.providers.map(provider => [provider.providerId, provider]));
  const ids = healthProviders.map(provider => provider.providerId);
  for (const fact of recovery.providers) {
    if (!healthById.has(fact.providerId)) ids.push(fact.providerId);
  }
  const healthSource = health?.schema_version === 2
    ? 'llm-instance-state.json#schema_version=2'
    : 'llm-instance-state.json#schema_version=1';
  const recoverySource = health?.schema_version === 2
    ? `${healthSource}:recovery.providers`
    : 'llm-recovery-state.json#schema_version=1:providers';
  const healthUpdatedAtMs = health === undefined ? undefined : Date.parse(health.updatedAt);

  const providers = ids.map<LLMProviderRecoveryState>(providerId => {
    const old = healthById.get(providerId);
    const fact = factById.get(providerId);
    const migrationSources: string[] = [];
    if (old) migrationSources.push(`${healthSource}:providers[${providerId}].breaker`);
    if (old?.sharedFailure) migrationSources.push(`${healthSource}:providers[${providerId}].sharedFailure`);
    if (fact) migrationSources.push(`${recoverySource}[${providerId}]`);

    let lastError: LLMProviderRecoveryState['lastError'];
    if (fact) {
      if (!isErrorClass(fact.errorClass)) {
        throw new Error(`legacy recovery provider ${providerId} has unmappable error class ${fact.errorClass}`);
      }
      const at = Date.parse(fact.at);
      if (!Number.isFinite(at)) throw new Error(`legacy recovery provider ${providerId} has invalid error time`);
      lastError = {
        class: fact.errorClass,
        at,
        message: fact.detail,
        ...(fact.providerLabel !== undefined ? { providerLabel: fact.providerLabel } : {}),
      };
    } else if (old?.sharedFailure) {
      if (healthUpdatedAtMs === undefined || !Number.isFinite(healthUpdatedAtMs)) {
        throw new Error(`legacy shared failure for ${providerId} has no auditable state time`);
      }
      lastError = {
        class: old.sharedFailure.errorClass,
        at: healthUpdatedAtMs,
        message: `legacy shared failure (${old.sharedFailure.errorClass})`,
      };
    } else if (old?.breaker.lastFailureClass) {
      const at = old.breaker.openedAtMs ?? healthUpdatedAtMs;
      if (at === undefined || !Number.isFinite(at)) {
        throw new Error(`legacy breaker failure for ${providerId} has no auditable error time`);
      }
      lastError = {
        class: old.breaker.lastFailureClass,
        at,
        message: `legacy circuit breaker failure (${old.breaker.lastFailureClass})`,
      };
    }
    if (lastError) lastError.migrationSources = migrationSources;

    const waiting = old?.breaker.state === 'open'
      || old?.sharedFailure !== undefined
      || fact?.blocking === true
      || fact?.rateLimitBlocked === true;
    const retryLowerBounds: number[] = [];
    if (old?.sharedFailure?.floorMs !== undefined) retryLowerBounds.push(old.sharedFailure.floorMs);
    if (waiting && fact?.retryAt !== undefined) {
      const retryAt = Date.parse(fact.retryAt);
      if (!Number.isFinite(retryAt)) throw new Error(`legacy recovery provider ${providerId} has invalid retryAt`);
      retryLowerBounds.push(retryAt);
    }
    if (fact?.rateLimitBlocked === true || (waiting && retryLowerBounds.length === 0)) {
      retryLowerBounds.push(nowMs + LEGACY_WAITING_RETRY_DELAY_MS);
    }
    const failureCounts = [old?.breaker.consecutiveFailures, fact?.consecutiveFailures]
      .filter((count): count is number => count !== undefined);
    return {
      providerId,
      status: waiting ? 'waiting' : 'available',
      ...(waiting ? { retryAt: Math.max(...retryLowerBounds) } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(failureCounts.length > 0 ? { consecutiveFailures: Math.max(...failureCounts) } : {}),
    };
  });

  if (health?.schema_version === 2 && health.lastSuccess) {
    const provider = providers.find(candidate => candidate.providerId === health.lastSuccess?.providerId);
    if (!provider || !health.providers.some(candidate => candidate.providerId === health.lastSuccess?.providerId)) {
      throw new Error(`legacy lastSuccess provider ${health.lastSuccess.providerId} has no health state`);
    }
    const hasLastUsedAt = health.lastSuccess.lastUsedAt !== undefined;
    const hasCacheValidUntil = health.lastSuccess.cacheValidUntil !== undefined;
    if (hasLastUsedAt !== hasCacheValidUntil) {
      throw new Error(`legacy lastSuccess provider ${health.lastSuccess.providerId} has incomplete cache times`);
    }
    if (hasLastUsedAt && hasCacheValidUntil) {
      const lastSuccessAt = health.lastSuccess.lastUsedAt;
      const cacheValidUntil = health.lastSuccess.cacheValidUntil;
      if (!isNonNegativeNumber(lastSuccessAt) || !isNonNegativeNumber(cacheValidUntil) || cacheValidUntil < lastSuccessAt) {
        throw new Error(`legacy lastSuccess provider ${health.lastSuccess.providerId} has invalid cache times`);
      }
      provider.lastSuccessAt = lastSuccessAt;
      provider.cacheValidUntil = cacheValidUntil;
    }
  }
  return providers;
}

/** V1/V2/旧 scope → V3 的唯一迁移入口；不可无损表达时拒绝，不修改旧原文。 */
export function upgradeLLMInstanceState(
  health: LLMInstanceStateV1 | LLMInstanceStateV2 | undefined,
  legacy: LLMRecoveryStateV1 | undefined,
  nowMs = Date.now(),
  currentProviderIds: readonly string[] = [],
  legacyProviderIds: readonly string[] = [],
): LLMInstanceStateV3 {
  if (!isNonNegativeNumber(nowMs)) throw new Error('legacy migration nowMs must be a non-negative finite number');
  const recovery = health?.schema_version === 2
    ? cloneRecoveryState(health.recovery)
    : legacy
      ? importLegacyRecovery(legacy, currentProviderIds, legacyProviderIds)
      : createEmptyLLMInstanceRecoveryState();
  const state: LLMInstanceStateV3 = {
    schema_version: 3,
    instanceId: health?.schema_version === 2 ? health.instanceId : `llm-${newUuid()}`,
    revision: Math.max(health?.revision ?? 0, health?.schema_version === 2 ? 0 : legacy?.revision ?? 0)
      + (health || legacy ? 1 : 0),
    updatedAt: new Date(nowMs).toISOString(),
    providers: migrateProviderStates(health, recovery, nowMs),
    recovery,
  };
  if (!validateV3(state)) throw new Error('legacy instance state cannot be mapped losslessly to V3');
  return state;
}

export function loadLLMInstanceState(fs: FileSystem, stateDir?: string): LLMInstanceStateLoad {
  let raw: string;
  try {
    raw = fs.readSync(instanceStatePath(stateDir));
  } catch (error) {
    if (isFileNotFound(error)) return { kind: 'missing' };
    return { kind: 'unusable', reason: 'read_failed', detail: formatErr(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'unusable', reason: 'parse_failed', detail: formatErr(error) };
  }
  if (isRecord(parsed) && parsed.schema_version === 1) {
    if (!validateV1(parsed)) return { kind: 'unusable', reason: 'schema_invalid', detail: 'invalid LLM instance state V1' };
    return { kind: 'legacy', state: parsed };
  }
  if (isRecord(parsed) && parsed.schema_version === 2) {
    if (!validateV2(parsed)) return { kind: 'unusable', reason: 'schema_invalid', detail: 'invalid LLM instance state V2' };
    return { kind: 'legacy', state: parsed };
  }
  if (isRecord(parsed) && parsed.schema_version === 3) {
    if (!validateV3(parsed)) return { kind: 'unusable', reason: 'schema_invalid', detail: 'invalid LLM instance state V3' };
    return { kind: 'ok', state: parsed };
  }
  return { kind: 'unusable', reason: 'schema_invalid', detail: 'unknown LLM instance state schema' };
}

export function saveLLMInstanceState(
  fs: FileSystem,
  state: LLMInstanceStateV3,
  stateDir?: string,
): ReturnType<FileSystem['writeAtomicSync']> {
  if (!validateV3(state)) throw new Error('Refusing to persist invalid LLM instance state V3');
  fs.ensureDirSync(stateDir ?? 'status');
  return fs.writeAtomicSync(instanceStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}
