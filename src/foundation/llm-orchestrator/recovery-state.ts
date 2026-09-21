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

/** 原始失败证据（保留错误本身，不用显示摘要替代）。 */
export interface LLMRecoveryFailureEvidence {
  at: string;
  providerId: string;
  errorClass: string;
  message: string;
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
  if (s.acceptedFactBatches !== undefined) {
    if (!Array.isArray(s.acceptedFactBatches) || !s.acceptedFactBatches.every(isAcceptedFactBatch)) {
      return { ok: false, reason: 'field_type_mismatch', detail: 'acceptedFactBatches' };
    }
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
