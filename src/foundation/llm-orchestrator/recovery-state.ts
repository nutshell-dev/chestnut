/**
 * @module L2b.LLMOrchestrator.RecoveryState
 * @layer L2b LLM 语义基础设施
 *
 * Phase 1826：LLM 恢复状态的持久化形态。owner（LLMOrchestrator）拥有
 * schema、文件名、校验、迁移 intake 与降级导出；调用方只见注入的 FileSystem
 * 与稳定 opaque scope，不解析内部字段。
 *
 * 顺序不变量：读取/严格校验 → 决定新状态 → 原子持久化 → 发布安排。
 * 非法/未知版本/无法无损映射的输入拒绝启动并保留原文，不猜默认值继续发请求。
 */

import * as path from 'path';
import { formatErr } from '../node-utils/index.js';
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import { STATUS_SUBDIR } from '../process-manager/index.js';

/** 恢复状态持久化文件名（scope 注入的 FileSystem 下的 status/ 子目录）。 */
export const LLM_RECOVERY_STATE_FILE = 'llm-recovery-state.json' as const;

/** 保留的原始失败证据条数上限（有界，防状态文件无界增长）。 */
export const LLM_RECOVERY_FAILURE_EVIDENCE_MAX = 10;

/** 保留的已接受干预/配置修订标识条数上限。 */
export const LLM_RECOVERY_ACCEPTED_IDS_MAX = 64;

/** 对外发布的安排：ready=可直接工作；at=到点再试；on_change=等干预/配置变化。 */
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
}

/** 转义自既有已批准参数的恢复预算与曲线（数值不变）。 */
export interface LLMRecoveryBudget {
  retryCount: number;
  retryDelayMs: number;
  quotaDelayMs: number;
}

/** 活跃 admission：begin 成功创建；started 在首个真实 provider 请求前原子置位。 */
export interface LLMRecoveryAdmissionRecord {
  attemptId: string;
  started: boolean;
  startedAt?: string;
  requestKey: string;
  triggerKind: string;
  triggerId?: string;
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

/** 原始失败证据（保留错误本身，不用显示摘要替代）。 */
export interface LLMRecoveryFailureEvidence {
  at: string;
  providerId: string;
  errorClass: string;
  message: string;
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
  importedSources: string[];
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
  if (s.kind === 'at') return typeof s.resumeAt === 'string' && !Number.isNaN(Date.parse(s.resumeAt));
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
  return typeof p.providerId === 'string' && p.providerId.length > 0
    && typeof p.errorClass === 'string'
    && typeof p.at === 'string'
    && typeof p.consecutiveFailures === 'number'
    && typeof p.detail === 'string';
}

function isAdmission(v: unknown): v is LLMRecoveryAdmissionRecord {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (typeof a.attemptId !== 'string' || a.attemptId.length === 0) return false;
  if (typeof a.started !== 'boolean') return false;
  if (typeof a.requestKey !== 'string') return false;
  if (typeof a.triggerKind !== 'string') return false;
  if (a.probeOnly !== undefined && typeof a.probeOnly !== 'boolean') return false;
  if (a.allowBreakerProbe !== undefined && typeof a.allowBreakerProbe !== 'boolean') return false;
  if (a.resumedFromRestart !== undefined && typeof a.resumedFromRestart !== 'boolean') return false;
  return true;
}

function isFailureEvidence(v: unknown): v is LLMRecoveryFailureEvidence {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.at === 'string'
    && typeof f.providerId === 'string'
    && typeof f.errorClass === 'string'
    && typeof f.message === 'string';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
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
  if (!isStringArray(s.importedSources)) {
    return { ok: false, reason: 'field_type_mismatch', detail: 'importedSources' };
  }
  if (typeof s.updatedAt !== 'string') {
    return { ok: false, reason: 'field_type_mismatch', detail: 'updatedAt' };
  }
  return { ok: true, state: s as unknown as LLMRecoveryStateV1 };
}

// ---------------------------------------------------------------------------
// 读写（原子写；读失败语义由调用方决定拒绝启动）
// ---------------------------------------------------------------------------

export type RecoveryStateLoad =
  | { kind: 'missing' }
  | { kind: 'ok'; state: LLMRecoveryStateV1 }
  | { kind: 'unusable'; reason: 'parse_failed' | 'schema_invalid' | 'field_type_mismatch' | 'scope_mismatch' | 'read_failed'; detail: string };

/** 相对 scope FileSystem base 的状态文件路径。 */
export function recoveryStateRelPath(): string {
  return path.join(STATUS_SUBDIR, LLM_RECOVERY_STATE_FILE);
}

export function loadRecoveryState(fs: FileSystem, scopeId: string): RecoveryStateLoad {
  let raw: string;
  try {
    raw = fs.readSync(recoveryStateRelPath());
  } catch (e) {
    // 失败原因以 typed RecoveryStateLoad 交给调用方（结构化暴露，不静默）
    if (isFileNotFound(e)) return { kind: 'missing' };
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

/**
 * 原子写。失败时抛 typed storage error——调用方不得在持久化失败后继续真发
 * 或发布成功安排；原状态文件保持不变。
 */
export function saveRecoveryState(fs: FileSystem, state: LLMRecoveryStateV1): void {
  try {
    fs.ensureDirSync(STATUS_SUBDIR);
    fs.writeAtomicSync(recoveryStateRelPath(), JSON.stringify(state));
  } catch (e) {
    throw new Error(`Failed to persist LLM recovery state: ${String(e)}`, { cause: e });
  }
}

/** 读取新格式原文（用于降级/迁移时保留不可表达信息并留存证据）。 */
export function readRecoveryStateRaw(fs: FileSystem): string | undefined {
  try {
    return fs.readSync(recoveryStateRelPath());
  } catch (e) {
    if (isFileNotFound(e)) return undefined;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 旧 owner 迁移 intake（中性数据；owner 不读 EventLoop 路径）
// ---------------------------------------------------------------------------

export interface LegacyWaitingExport {
  kind: 'retry' | 'cooldown';
  errorClass: string;
  resumeAt: string;
  attempt?: number;
  attempts?: number;
  maxAttempts?: number;
  error?: string;
}

export interface LegacyBlockedExport {
  reason: string;
  requestFingerprint: string;
  blockedAt: string;
  message?: string;
}

/**
 * 旧恢复数据的中性导出（旧 owner 读旧文件后构造）。
 * Phase 1826：llm-retry-state.json 的 waiting 与 provider 类 blocked 经此导入；
 * trim 类 blocked 不在此列（仍归 EventLoop）。
 */
export interface LegacyRecoveryExport {
  source: string;
  retryCount?: number;
  retryDelayMs?: number;
  quotaDelayMs?: number;
  waiting?: LegacyWaitingExport | null;
  blocked?: LegacyBlockedExport | null;
}

export type LegacyImportOutcome =
  | { kind: 'imported'; state: LLMRecoveryStateV1 }
  | { kind: 'already_imported'; state: LLMRecoveryStateV1 };

/**
 * 幂等导入：同一 source 摘要重复出现时不覆盖较新状态。
 * 旧等待保持原 resumeAt（不重新从「现在」开始计时）。
 */
export function importLegacyRecoveryExport(
  state: LLMRecoveryStateV1,
  legacy: LegacyRecoveryExport,
  nowMs: number,
): LegacyImportOutcome {
  if (state.importedSources.includes(legacy.source)) {
    return { kind: 'already_imported', state };
  }
  const next: LLMRecoveryStateV1 = {
    ...state,
    budget: { ...state.budget },
    providers: [...state.providers],
    acceptedInterventions: [...state.acceptedInterventions],
    acceptedConfigRevisions: [...state.acceptedConfigRevisions],
    failures: [...state.failures],
    importedSources: [...state.importedSources, legacy.source],
  };
  if (typeof legacy.retryCount === 'number') next.budget.retryCount = legacy.retryCount;
  if (typeof legacy.retryDelayMs === 'number') next.budget.retryDelayMs = legacy.retryDelayMs;
  if (typeof legacy.quotaDelayMs === 'number') next.budget.quotaDelayMs = legacy.quotaDelayMs;

  if (legacy.waiting) {
    const resumeMs = Date.parse(legacy.waiting.resumeAt);
    next.providers.push({
      providerId: 'legacy:inline',
      errorClass: legacy.waiting.errorClass,
      at: new Date(nowMs).toISOString(),
      consecutiveFailures: legacy.waiting.attempts ?? legacy.waiting.attempt ?? 0,
      detail: legacy.waiting.error ?? 'imported legacy waiting',
    });
    next.schedule = Number.isNaN(resumeMs) || resumeMs <= nowMs
      ? { kind: 'ready', revision: state.revision }
      : { kind: 'at', revision: state.revision, resumeAt: legacy.waiting.resumeAt };
  } else if (legacy.blocked) {
    next.providers.push({
      providerId: 'legacy:inline',
      errorClass: 'permanent',
      at: legacy.blocked.blockedAt,
      consecutiveFailures: 1,
      detail: legacy.blocked.message ?? `imported legacy blocked (${legacy.blocked.reason})`,
    });
    next.schedule = { kind: 'on_change', revision: state.revision };
  }

  next.revision = state.revision + 1;
  next.schedule = { ...next.schedule, revision: next.revision };
  next.updatedAt = new Date(nowMs).toISOString();
  return { kind: 'imported', state: next };
}

// ---------------------------------------------------------------------------
// 降级导出（回滚：新 owner 状态 → 旧版本可理解的恢复数据）
// ---------------------------------------------------------------------------

export interface LegacyRetryStateV2 {
  schema_version: 2;
  llmRetryCount: number;
  llmRetryDelayMs: number;
  llmQuotaDelayMs: number;
  llmRetryPending: false;
  waiting: {
    kind: 'retry' | 'cooldown';
    requestFingerprint: string;
    errorClass: string;
    attempt?: number;
    attempts?: number;
    maxAttempts: number;
    scheduledAt: string;
    resumeAt: string;
    error: string;
  } | null;
}

export interface LegacyBlockedStateV2 {
  version: 2;
  reason: 'permanent_provider_error' | 'invalid_request';
  requestFingerprint: string;
  blockedAt: string;
  message: string;
  userActionHint: null;
}

export type LegacyRecoveryExportResult =
  | {
      kind: 'exported';
      retry: LegacyRetryStateV2;
      blocked: LegacyBlockedStateV2 | null;
      /** 旧格式无法表达、保留在新格式原文中的信息（intervention/admission 等）。 */
      unrepresentable: string[];
    }
  | { kind: 'unrepresentable'; reason: 'future_schema' | 'in_flight_admission' };

/**
 * 将最新安排转换为旧版本可理解的恢复数据。
 * - at 安排 → v2 waiting（kind=retry；cooldown 语义无法恢复时按 retry 表达）。
 * - on_change（provider 类阻断）→ v2 blocked（permanent_provider_error）。
 * - started 的 in-flight admission 无法安全映射 → 拒绝降级并保留数据。
 */
export function exportLegacyRecoveryState(
  state: LLMRecoveryStateV1,
  nowMs: number,
): LegacyRecoveryExportResult {
  if ((state.schema_version as number) !== 1) {
    return { kind: 'unrepresentable', reason: 'future_schema' };
  }
  if (state.activeAdmission?.started) {
    return { kind: 'unrepresentable', reason: 'in_flight_admission' };
  }
  const unrepresentable: string[] = [];
  if (state.acceptedInterventions.length > 0) {
    unrepresentable.push(`acceptedInterventions=${state.acceptedInterventions.length}`);
  }
  if (state.acceptedConfigRevisions.length > 0) {
    unrepresentable.push(`acceptedConfigRevisions=${state.acceptedConfigRevisions.length}`);
  }
  if (state.failures.length > 0) {
    unrepresentable.push(`failures=${state.failures.length}`);
  }

  let waiting: LegacyRetryStateV2['waiting'] = null;
  let blocked: LegacyBlockedStateV2 | null = null;
  const nowIso = new Date(nowMs).toISOString();
  const latestFailure = state.failures[state.failures.length - 1];
  if (state.schedule.kind === 'at') {
    waiting = {
      kind: 'retry',
      requestFingerprint: latestFailure?.providerId ?? 'recovery-export',
      errorClass: latestFailure?.errorClass ?? 'transient',
      attempts: state.budget.retryCount,
      maxAttempts: state.budget.retryCount,
      scheduledAt: nowIso,
      resumeAt: state.schedule.resumeAt,
      error: latestFailure?.message ?? 'exported recovery schedule',
    };
  } else if (state.schedule.kind === 'on_change') {
    blocked = {
      version: 2,
      reason: 'permanent_provider_error',
      requestFingerprint: latestFailure?.providerId ?? 'recovery-export',
      blockedAt: latestFailure?.at ?? nowIso,
      message: latestFailure?.message ?? 'exported recovery block',
      userActionHint: null,
    };
  }

  return {
    kind: 'exported',
    retry: {
      schema_version: 2,
      llmRetryCount: state.budget.retryCount,
      llmRetryDelayMs: state.budget.retryDelayMs,
      llmQuotaDelayMs: state.budget.quotaDelayMs,
      llmRetryPending: false,
      waiting,
    },
    blocked,
    unrepresentable,
  };
}
