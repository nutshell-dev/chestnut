/**
 * @module L2b.LLMOrchestrator.RecoveryState
 * @layer L2b LLM 语义基础设施
 *
 * Phase 2055：本模块仅是旧 llm-recovery-state/llm-retry-state 的只读 intake。
 * 新事实、revision 与原子写统一归 instance-state.ts；这里不提供任何写出口。
 * 非法/未知版本/无法无损映射的输入拒绝启动并保留原文，不猜默认值继续发请求。
 */

import * as path from 'path';
import { formatErr } from '../node-utils/index.js';
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import {
  LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
} from './defaults.js';

/** 恢复状态持久化文件名（scope 注入的 FileSystem 下的 status/ 子目录）。 */
export const LLM_RECOVERY_STATE_FILE = 'llm-recovery-state.json' as const;

/** 保留的原始失败证据条数上限（有界，防状态文件无界增长）。 */
export const LLM_RECOVERY_FAILURE_EVIDENCE_MAX = 10;

/** 失败证据有界保留丢失记录的协议版本。 */
export const LLM_RECOVERY_FAILURE_EVIDENCE_POLICY_VERSION = 1 as const;

/** 保留的已接受干预/配置修订标识条数上限。 */
export const LLM_RECOVERY_ACCEPTED_IDS_MAX = 64;

/**
 * 对外发布的安排：ready=可直接工作；at=到点再试；on_change=等干预/配置变化。
 * Phase 1950 Step B：这是 owner（LLMOrchestrator）产生并持久化的只读事实；
 * 调用方只消费（等待/重查），不得自行构造 schedule 或改写 revision/resumeAt。
 */
export type LLMRecoverySchedule =
  | { kind: 'ready'; revision: number }
  | { kind: 'at'; revision: number; resumeAt: string }
  | { kind: 'on_change'; revision: number };

/** 单个 provider 的最近失败事实（身份为不可逆指纹，不含明文凭据）。 */
export interface LLMRecoveryProviderFact {
  /** 不可逆 provider 身份指纹（endpoint/model/credentials 摘要）。 */
  providerId: string;
  errorClass: string;
  at: string;
  consecutiveFailures: number;
  /** 显示用摘要（不含凭据）。 */
  detail: string;
  /**
   * Phase 1955 Step B：无 Retry-After 的 rate-limit 连续失败计数。
   * 可选：旧文件无此字段，按 0 解释；与 transient retryCount 语义独立。
   */
  rateLimitFailures?: number;
  /**
   * Phase 2034 起仅作 legacy 证据：旧文件用于 begin 迁移到末档 at；新失败不再写入，
   * scoped 候选也不再按此字段排除。schema 与原字段保留，历史事实不删除。
   */
  rateLimitBlocked?: boolean;
  rateLimitBlockedAt?: string;
  /**
   * Phase 1968 Step B：显示名（label）。身份指纹不含可读名称，label 随事实留存
   * 使身份↔名称关系可见（改名产生新身份时可解释健康状态迁移）。可选：旧文件缺失。
   */
  providerLabel?: string;
  /**
   * Phase 2027：旧算法身份已重键到当前身份，但尚未确认配置修订是否不变。
   * 可选以保持旧文件兼容；新修订必须对标记事实做一次保守重估。
   */
  identityMigrationPending?: boolean;
}

/** 转义自既有已批准参数的恢复预算与曲线（数值不变）。 */
export interface LLMRecoveryBudget {
  retryCount: number;
  retryDelayMs: number;
  quotaDelayMs: number;
}

/** 活跃 admission：begin 成功创建；started 在首个真实 provider 请求前原子置位。 */
export interface LLMRecoveryAdmissionRecord {
  /** 缺省表示 2032 前的 turn 级记录；新记录必须显式标记 invocation。 */
  admissionKind?: 'invocation';
  attemptId: string;
  started: boolean;
  startedAt?: string;
  requestKey: string;
  /** 显示兼容摘要（单一主原因）；完整事实关联见下面可选字段。 */
  triggerKind: string;
  triggerId?: string;
  /**
   * Phase 1827: 本准入关联的完整恢复事实（本批新接受的部分）。
   * 可选：旧文件无此字段——保留 triggerKind/triggerId 作为历史证据，不伪造不存在的 ids。
   */
  interventionIds?: string[];
  configurationRevision?: string;
  startupId?: string;
  /**
   * 恢复 probe 模式：本 attempt 每候选至多一次真实调用（正常预算另计）。
   * 可选：Z 补修前写入的状态文件无此字段，按 false（既有行为）解释，不猜新语义。
   */
  probeOnly?: boolean;
  /**
   * 显式干预/启动放行：候选不被本地 breaker 立即拒绝（一次性、不影响其他 caller）。
   * 可选：同上，旧文件缺省按 false 解释。
   */
  allowBreakerProbe?: boolean;
  /** 进程重启后恢复的、尚未开始的准入（下次 begin 重新驱动同一 attempt）。 */
  resumedFromRestart?: boolean;
}

/** 有界保留截断掉的失败证据记录；只描述丢失事实，不承诺外部可恢复。 */
export interface LLMRecoveryFailureEvidenceLoss {
  droppedCount: number;
  firstDroppedAt?: string;
  lastDroppedAt?: string;
  reason: 'bounded_retention';
  policyVersion: typeof LLM_RECOVERY_FAILURE_EVIDENCE_POLICY_VERSION;
  recoverability: 'not_preserved_in_recovery_state';
}

/** 原始失败证据（保留错误本身，不用显示摘要替代）。 */
export interface LLMRecoveryFailureEvidence {
  at: string;
  providerId: string;
  errorClass: string;
  message: string;
  /**
   * Phase 1968 Step B：调用路径关联（可选，旧文件缺失不猜）。
   * 与 llm_call_invocation_started/llm_call_attempt_result 审计事件同源——
   * 重启后可由 invocationId 对齐磁盘审计与恢复证据，不伪造未发生的成功。
   */
  providerLabel?: string;
  invocationId?: string;
  attemptId?: string;
  attemptIndex?: number;
  configRevision?: number;
}

/**
 * Phase 1827: 一次「事实接受」批次的持久证据。
 * 只在接受新事实时追加；重复输入不追加；是本 owner 的事实接受历史，不是通知队列
 * （无有界截断——事件出口不可靠，磁盘记录是证据权威）。
 */
export interface LLMRecoveryAcceptedFactBatch {
  scope: string;
  revision: number;
  interventionIds: string[];
  configurationRevision?: string;
  startupId?: string;
  attemptId?: string;
}

export interface LLMRecoveryStateV1 {
  schema_version: 1;
  scopeId: string;
  revision: number;
  schedule: LLMRecoverySchedule;
  budget: LLMRecoveryBudget;
  providers: LLMRecoveryProviderFact[];
  acceptedInterventions: string[];
  acceptedConfigRevisions: string[];
  lastStartupProbeId?: string;
  activeAdmission: LLMRecoveryAdmissionRecord | null;
  failures: LLMRecoveryFailureEvidence[];
  /** Phase 2035：超出有界保留的证据丢失记录；旧文件缺省表示尚无记录。 */
  failureEvidenceLoss?: LLMRecoveryFailureEvidenceLoss;
  importedSources: string[];
  /** Phase 1827: 事实接受历史（可选——旧文件无此字段；缺失表示尚无 1827 批次记录）。 */
  acceptedFactBatches?: LLMRecoveryAcceptedFactBatch[];
  updatedAt: string;
}

export function createInitialRecoveryState(
  scopeId: string,
  initialBudget: LLMRecoveryBudget,
  nowMs: number,
): LLMRecoveryStateV1 {
  return {
    schema_version: 1,
    scopeId,
    revision: 1,
    schedule: { kind: 'ready', revision: 1 },
    budget: { ...initialBudget },
    providers: [],
    acceptedInterventions: [],
    acceptedConfigRevisions: [],
    activeAdmission: null,
    failures: [],
    importedSources: [],
    updatedAt: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 严格校验
// ---------------------------------------------------------------------------

export type RecoveryStateValidation =
  | { ok: true; state: LLMRecoveryStateV1 }
  | { ok: false; reason: 'schema_invalid' | 'field_type_mismatch' | 'scope_mismatch'; detail: string };

function isSchedule(v: unknown): v is LLMRecoverySchedule {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.revision !== 'number') return false;
  if (s.kind === 'ready' || s.kind === 'on_change') return true;
  if (s.kind === 'at') return typeof s.resumeAt === 'string';
  return false;
}

function isBudget(v: unknown): v is LLMRecoveryBudget {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return typeof b.retryCount === 'number'
    && typeof b.retryDelayMs === 'number'
    && typeof b.quotaDelayMs === 'number';
}

function isProviderFact(v: unknown): v is LLMRecoveryProviderFact {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (
    typeof p.providerId !== 'string' || p.providerId.length === 0
    || typeof p.errorClass !== 'string'
    || typeof p.at !== 'string'
    || typeof p.consecutiveFailures !== 'number'
    || typeof p.detail !== 'string'
  ) return false;
  // Phase 1955 Step B：新增字段可选（旧文件兼容），出现时严格校验类型。
  if (p.rateLimitFailures !== undefined && typeof p.rateLimitFailures !== 'number') return false;
  if (p.rateLimitBlocked !== undefined && typeof p.rateLimitBlocked !== 'boolean') return false;
  if (p.rateLimitBlockedAt !== undefined && typeof p.rateLimitBlockedAt !== 'string') return false;
  // Phase 1968 Step B：label 可选，出现时严格校验。
  if (p.providerLabel !== undefined && typeof p.providerLabel !== 'string') return false;
  if (p.identityMigrationPending !== undefined && typeof p.identityMigrationPending !== 'boolean') return false;
  return true;
}

function isAdmission(v: unknown): v is LLMRecoveryAdmissionRecord {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (a.admissionKind !== undefined && a.admissionKind !== 'invocation') return false;
  if (typeof a.attemptId !== 'string' || a.attemptId.length === 0) return false;
  if (typeof a.started !== 'boolean') return false;
  if (typeof a.requestKey !== 'string') return false;
  if (typeof a.triggerKind !== 'string') return false;
  if (a.probeOnly !== undefined && typeof a.probeOnly !== 'boolean') return false;
  if (a.allowBreakerProbe !== undefined && typeof a.allowBreakerProbe !== 'boolean') return false;
  if (a.resumedFromRestart !== undefined && typeof a.resumedFromRestart !== 'boolean') return false;
  // Phase 1827：完整事实关联（可选；旧文件缺失时保留兼容标量为历史证据）。
  if (a.interventionIds !== undefined && !isStringArray(a.interventionIds)) return false;
  if (a.configurationRevision !== undefined && typeof a.configurationRevision !== 'string') return false;
  if (a.startupId !== undefined && typeof a.startupId !== 'string') return false;
  return true;
}

function isAcceptedFactBatch(v: unknown): v is LLMRecoveryAcceptedFactBatch {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  if (typeof b.scope !== 'string' || b.scope.length === 0) return false;
  if (typeof b.revision !== 'number') return false;
  if (!isStringArray(b.interventionIds)) return false;
  if (b.configurationRevision !== undefined && typeof b.configurationRevision !== 'string') return false;
  if (b.startupId !== undefined && typeof b.startupId !== 'string') return false;
  if (b.attemptId !== undefined && typeof b.attemptId !== 'string') return false;
  return true;
}

function isFailureEvidence(v: unknown): v is LLMRecoveryFailureEvidence {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  if (typeof f.at !== 'string'
    || typeof f.providerId !== 'string'
    || typeof f.errorClass !== 'string'
    || typeof f.message !== 'string') return false;
  // Phase 1968 Step B：调用路径关联字段可选，出现时严格校验类型。
  if (f.providerLabel !== undefined && typeof f.providerLabel !== 'string') return false;
  if (f.invocationId !== undefined && typeof f.invocationId !== 'string') return false;
  if (f.attemptId !== undefined && typeof f.attemptId !== 'string') return false;
  if (f.attemptIndex !== undefined && typeof f.attemptIndex !== 'number') return false;
  if (f.configRevision !== undefined && typeof f.configRevision !== 'number') return false;
  return true;
}

function isFailureEvidenceLoss(v: unknown): v is LLMRecoveryFailureEvidenceLoss {
  if (typeof v !== 'object' || v === null) return false;
  const loss = v as Record<string, unknown>;
  if (typeof loss.droppedCount !== 'number'
    || loss.reason !== 'bounded_retention'
    || loss.policyVersion !== LLM_RECOVERY_FAILURE_EVIDENCE_POLICY_VERSION
    || loss.recoverability !== 'not_preserved_in_recovery_state') return false;
  if (loss.firstDroppedAt !== undefined && typeof loss.firstDroppedAt !== 'string') return false;
  if (loss.lastDroppedAt !== undefined && typeof loss.lastDroppedAt !== 'string') return false;
  return true;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegativeInteger(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

function isPositiveFiniteNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

function isRevision(v: unknown): v is number {
  return isNonNegativeInteger(v) && v >= 1;
}

function isIsoDateString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** 结构校验后的语义校验；返回具体字段，非法状态继续 fail-closed。 */
function recoveryStateSemanticMismatch(s: Record<string, unknown>): string | undefined {
  if (!isRevision(s.revision)) return 'revision';

  const schedule = s.schedule as LLMRecoverySchedule;
  if (!isRevision(schedule.revision) || schedule.revision !== s.revision) return 'schedule.revision';
  if (schedule.kind === 'at' && !isIsoDateString(schedule.resumeAt)) return 'schedule.resumeAt';

  const budget = s.budget as LLMRecoveryBudget;
  if (!isNonNegativeInteger(budget.retryCount)) return 'budget.retryCount';
  if (!isPositiveFiniteNumber(budget.retryDelayMs)) return 'budget.retryDelayMs';
  if (!isPositiveFiniteNumber(budget.quotaDelayMs)) return 'budget.quotaDelayMs';

  const providers = s.providers as LLMRecoveryProviderFact[];
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    if (!isIsoDateString(provider.at)) return `providers[${i}].at`;
    if (!isNonNegativeInteger(provider.consecutiveFailures)) return `providers[${i}].consecutiveFailures`;
    if (provider.rateLimitFailures !== undefined && !isNonNegativeInteger(provider.rateLimitFailures)) {
      return `providers[${i}].rateLimitFailures`;
    }
    if (provider.rateLimitBlockedAt !== undefined && !isIsoDateString(provider.rateLimitBlockedAt)) {
      return `providers[${i}].rateLimitBlockedAt`;
    }
  }

  const admission = s.activeAdmission as LLMRecoveryAdmissionRecord | null;
  if (admission?.startedAt !== undefined && !isIsoDateString(admission.startedAt)) {
    return 'activeAdmission.startedAt';
  }

  const failures = s.failures as LLMRecoveryFailureEvidence[];
  for (let i = 0; i < failures.length; i++) {
    const failure = failures[i];
    if (!isIsoDateString(failure.at)) return `failures[${i}].at`;
    if (failure.attemptIndex !== undefined && !isNonNegativeInteger(failure.attemptIndex)) {
      return `failures[${i}].attemptIndex`;
    }
    if (failure.configRevision !== undefined && !isNonNegativeInteger(failure.configRevision)) {
      return `failures[${i}].configRevision`;
    }
  }

  const batches = (s.acceptedFactBatches ?? []) as LLMRecoveryAcceptedFactBatch[];
  for (let i = 0; i < batches.length; i++) {
    if (!isRevision(batches[i].revision) || batches[i].revision > (s.revision as number)) {
      return `acceptedFactBatches[${i}].revision`;
    }
  }

  const loss = s.failureEvidenceLoss as LLMRecoveryFailureEvidenceLoss | undefined;
  if (loss) {
    if (!isNonNegativeInteger(loss.droppedCount)) return 'failureEvidenceLoss.droppedCount';
    if (loss.droppedCount > 0 && (loss.firstDroppedAt === undefined || loss.lastDroppedAt === undefined)) {
      return 'failureEvidenceLoss.firstDroppedAt/lastDroppedAt';
    }
    if (loss.firstDroppedAt !== undefined && !isIsoDateString(loss.firstDroppedAt)) {
      return 'failureEvidenceLoss.firstDroppedAt';
    }
    if (loss.lastDroppedAt !== undefined && !isIsoDateString(loss.lastDroppedAt)) {
      return 'failureEvidenceLoss.lastDroppedAt';
    }
  }

  if (!isIsoDateString(s.updatedAt)) return 'updatedAt';
  return undefined;
}

export function validateRecoveryState(
  saved: unknown,
  scopeId: string,
): RecoveryStateValidation {
  if (typeof saved !== 'object' || saved === null) {
    return { ok: false, reason: 'schema_invalid', detail: `actual=${typeof saved}` };
  }
  const s = saved as Record<string, unknown>;
  if (s.schema_version !== 1) {
    return { ok: false, reason: 'schema_invalid', detail: `schema_version=${String(s.schema_version)}` };
  }
  if (typeof s.scopeId !== 'string' || s.scopeId.length === 0) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'scopeId' };
  }
  if (s.scopeId !== scopeId) {
    return { ok: false, reason: 'scope_mismatch', detail: `expected=${scopeId} actual=${s.scopeId}` };
  }
  if (typeof s.revision !== 'number' || !Number.isInteger(s.revision) || s.revision < 1) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'revision' };
  }
  if (!isSchedule(s.schedule)) return { ok: false, reason: 'field_type_mismatch', detail: 'schedule' };
  if (!isBudget(s.budget)) return { ok: false, reason: 'field_type_mismatch', detail: 'budget' };
  if (!Array.isArray(s.providers) || !s.providers.every(isProviderFact)) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'providers' };
  }
  if (!isStringArray(s.acceptedInterventions)) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'acceptedInterventions' };
  }
  if (!isStringArray(s.acceptedConfigRevisions)) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'acceptedConfigRevisions' };
  }
  if (s.lastStartupProbeId !== undefined && typeof s.lastStartupProbeId !== 'string') {
    return { ok: false, reason: 'field_type_mismatch', detail: 'lastStartupProbeId' };
  }
  if (s.activeAdmission !== null && !isAdmission(s.activeAdmission)) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'activeAdmission' };
  }
  if (!Array.isArray(s.failures) || !s.failures.every(isFailureEvidence)) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'failures' };
  }
  if (s.failureEvidenceLoss !== undefined && !isFailureEvidenceLoss(s.failureEvidenceLoss)) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'failureEvidenceLoss' };
  }
  if (!isStringArray(s.importedSources)) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'importedSources' };
  }
  if (s.acceptedFactBatches !== undefined) {
    if (!Array.isArray(s.acceptedFactBatches) || !s.acceptedFactBatches.every(isAcceptedFactBatch)) {
      return { ok: false, reason: 'field_type_mismatch', detail: 'acceptedFactBatches' };
    }
  }
  if (typeof s.updatedAt !== 'string') {
    return { ok: false, reason: 'field_type_mismatch', detail: 'updatedAt' };
  }
  const semanticMismatch = recoveryStateSemanticMismatch(s);
  if (semanticMismatch !== undefined) {
    return { ok: false, reason: 'field_type_mismatch', detail: semanticMismatch };
  }
  return { ok: true, state: s as unknown as LLMRecoveryStateV1 };
}

// ---------------------------------------------------------------------------
// 只读导入（读失败语义由调用方决定拒绝启动）
// ---------------------------------------------------------------------------

export type RecoveryStateLoad =
  | { kind: 'missing' }
  | { kind: 'ok'; state: LLMRecoveryStateV1; imported?: true }
  | { kind: 'unusable'; reason: 'parse_failed' | 'schema_invalid' | 'field_type_mismatch' | 'scope_mismatch' | 'read_failed'; detail: string };

/** 相对 scope FileSystem base 的状态文件路径；缺省 status 仅作旧文件兼容。 */
export function recoveryStateRelPath(stateDir = 'status'): string {
  return path.join(stateDir, LLM_RECOVERY_STATE_FILE);
}

const LEGACY_RETRY_STATE_REL_PATH = path.join('status', 'llm-retry-state.json');
const LEGACY_RETRY_STATE_SOURCE = 'status/llm-retry-state.json#schema_version=2';
const LEGACY_RETRY_STATE_KEYS = new Set([
  'schema_version',
  'llmRetryCount',
  'llmRetryDelayMs',
  'llmQuotaDelayMs',
  'llmRetryPending',
  'waiting',
]);

function loadLegacyRetryStateV2(
  fs: FileSystem,
  scopeId: string,
  initialBudget: LLMRecoveryBudget,
  nowMs: number,
): RecoveryStateLoad {
  let raw: string;
  try {
    raw = fs.readSync(LEGACY_RETRY_STATE_REL_PATH);
  } catch (e) {
    if (isFileNotFound(e)) return { kind: 'missing' };
    return { kind: 'unusable', reason: 'read_failed', detail: formatErr(e) };
  }

  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch (e) {
    return { kind: 'unusable', reason: 'parse_failed', detail: formatErr(e) };
  }
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
    return { kind: 'unusable', reason: 'schema_invalid', detail: 'legacy retry state must be an object' };
  }
  const legacy = saved as Record<string, unknown>;
  if (legacy.schema_version !== 2) {
    return {
      kind: 'unusable',
      reason: 'schema_invalid',
      detail: `legacy schema_version=${String(legacy.schema_version)}`,
    };
  }
  const unknownKey = Object.keys(legacy).find(key => !LEGACY_RETRY_STATE_KEYS.has(key));
  if (unknownKey !== undefined) {
    return { kind: 'unusable', reason: 'schema_invalid', detail: `legacy unknown field=${unknownKey}` };
  }
  if (!isNonNegativeInteger(legacy.llmRetryCount)) {
    return { kind: 'unusable', reason: 'field_type_mismatch', detail: 'legacy llmRetryCount' };
  }
  if (!isPositiveFiniteNumber(legacy.llmRetryDelayMs)) {
    return { kind: 'unusable', reason: 'field_type_mismatch', detail: 'legacy llmRetryDelayMs' };
  }
  if (legacy.llmQuotaDelayMs !== undefined && !isPositiveFiniteNumber(legacy.llmQuotaDelayMs)) {
    return { kind: 'unusable', reason: 'field_type_mismatch', detail: 'legacy llmQuotaDelayMs' };
  }
  if (legacy.llmRetryPending !== false || legacy.waiting !== null) {
    return {
      kind: 'unusable',
      reason: 'schema_invalid',
      detail: 'legacy pending/waiting cannot be mapped losslessly',
    };
  }

  const state = createInitialRecoveryState(scopeId, {
    retryCount: legacy.llmRetryCount,
    retryDelayMs: legacy.llmRetryDelayMs,
    quotaDelayMs: legacy.llmQuotaDelayMs ?? initialBudget.quotaDelayMs,
  }, nowMs);
  state.importedSources = [LEGACY_RETRY_STATE_SOURCE];
  return { kind: 'ok', state, imported: true };
}

export function loadRecoveryState(
  fs: FileSystem,
  scopeId: string,
  stateDir = 'status',
  initialBudget: LLMRecoveryBudget = {
    retryCount: 0,
    retryDelayMs: LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
    quotaDelayMs: LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  },
  nowMs = Date.now(),
): RecoveryStateLoad {
  let raw: string;
  try {
    raw = fs.readSync(recoveryStateRelPath(stateDir));
  } catch (e) {
    // 新文件缺失才尝试已知旧格式；新文件存在时无论合法与否均为唯一权威。
    if (isFileNotFound(e)) return loadLegacyRetryStateV2(fs, scopeId, initialBudget, nowMs);
    return { kind: 'unusable', reason: 'read_failed', detail: formatErr(e) };
  }
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch (e) {
    // 解析失败以 typed unusable 暴露；文件保留不覆盖
    return { kind: 'unusable', reason: 'parse_failed', detail: formatErr(e) };
  }
  const v = validateRecoveryState(saved, scopeId);
  if (!v.ok) return { kind: 'unusable', reason: v.reason, detail: v.detail };
  return { kind: 'ok', state: v.state };
}
