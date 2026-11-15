/**
 * LLMOrchestrator (L2b) error types — retry policy + all-providers-failed.
 *
 * LLM base error classes (LLMError, LLMRateLimitError, etc.) live in L1
 * llm-provider/errors.ts per M#5 (L1 provider adapters throw them, so they
 * must not be defined in a higher layer).
 *
 * classifyLLMError / getUserActionHint are retry-policy functions that
 * operate on L1 error classes; they belong to L2b where retry logic lives.
 */

import type { LLMRecoverySchedule } from './recovery-state.js';
import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMQuotaError,
  LLMNetworkError,
  LLMTimeoutError,
  LLMContextExceededError,
  LLMOutputBudgetExceededError,
  LLMInvalidRequestError,
  type InputBudgetEvidence,
  isAbortError,
} from '../llm-provider/index.js';

type OrchestratorErrorCode = 'LLM_ALL_PROVIDERS_FAILED' | 'LLM_CIRCUIT_BREAKER_OPEN';

/** owner close 是不可逆终态；生命周期拒绝不属于 provider 故障分类。 */
export class LLMOrchestratorClosedError extends Error {
  readonly name = 'LLMOrchestratorClosedError';

  constructor() {
    super('LLM orchestrator is closed');
  }
}

/** invocation 尚未获准执行；上层只回队来源并等待 owner schedule。 */
export class LLMRecoveryWaitRequiredError extends Error {
  readonly name = 'LLMRecoveryWaitRequiredError';

  constructor(
    readonly schedule: LLMRecoverySchedule,
    readonly factsAccepted: boolean,
  ) {
    super('LLM recovery admission is waiting');
  }
}

/**
 * 单候选失败条目（LLMAllProvidersFailedError.failures 元素）。
 *
 * Phase 1934 Z-C1：providerId 是稳定候选身份指纹（name+apiFormat+model+baseUrl+
 * apiKeyHash），由 LLMOrchestrator 在构造聚合错误时全链填入。显示名不是身份——
 * 同名不同 model/key/endpoint 是不同候选，按显示名定位会把多个候选的故障并到
 * 第一个同名候选上。providerId 缺省仅出现于外部手工构造（测试/第三方），
 * 消费端（共享故障记账）对此回退显示名定位。
 */
export interface LLMProviderFailure {
  provider: string;
  error: Error;
  providerId?: string;
  /** L2b 在审计入口已决定的分类；恢复与序列化不得再次猜测或覆盖。 */
  errorClass?: LLMErrorClass;
  /**
   * Phase 1968 Step B：该候选在本次 invocation 实际执行序列中的序位（含跳过），
   * 与 llm_call_attempt_result 审计事件的 attemptIndex 同源。缺省仅出现于外部
   * 手工构造（测试/第三方）或 1968 前的代码路径。
   */
  attemptIndex?: number;
  /** 本地资格跳过，未发生真实请求；保留审计事实但不消耗恢复预算。 */
  localSkip?: boolean;
}

/** 有界、非 secret 的 Error/cause 投影；对象 cause 不做未经审查的属性展开。 */
export interface SerializedErrorEvidence {
  name: string;
  message?: string;
  code?: string;
  cause?: SerializedErrorEvidence;
  failures?: readonly LLMFailureEvidence[];
  retryAfter?: number;
  resetAtMs?: number;
  timeoutMs?: number;
  status?: number;
  contextLimit?: number;
  inputTokens?: number;
  requestedMaxTokens?: number;
  inputBudget?: InputBudgetEvidence;
  /** false = 深度、循环、对象 cause 或文本长度导致证据降级。 */
  complete?: false;
}

/** L1 typed code + L2b family + 候选关系的稳定序列化契约。 */
export interface LLMFailureEvidence {
  family: LLMErrorClass;
  provider: string;
  providerId?: string;
  attemptIndex?: number;
  localSkip?: boolean;
  errorCode?: string;
  cause: SerializedErrorEvidence;
}

const ERROR_EVIDENCE_DEPTH_LIMIT = 8;

function redactErrorText(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '<redacted>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '<redacted>')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '<redacted>')
    .replace(/\bya29\.[0-9A-Za-z_-]+\b/g, '<redacted>')
    .replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted>')
    .replace(/\b(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|password)(?:["']?\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=<redacted>')
    .slice(0, 500);
}

function errorCodeOf(error: Error): string | undefined {
  if (error instanceof LLMError || error instanceof LLMAllProvidersFailedError || error instanceof LLMCircuitBreakerOpenError) {
    return error.code;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function serializeErrorEvidence(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): SerializedErrorEvidence {
  if (depth >= ERROR_EVIDENCE_DEPTH_LIMIT) return { name: 'DepthLimit', complete: false };
  if (!(value instanceof Error)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value);
      return {
        name: 'NonErrorCause',
        message: redactErrorText(text),
        ...(text.length > 500 ? { complete: false as const } : {}),
      };
    }
    return { name: 'NonErrorCause', complete: false };
  }
  if (seen.has(value)) return { name: 'CircularCause', complete: false };
  seen.add(value);
  const result: SerializedErrorEvidence = {
    name: value.name,
    message: redactErrorText(value.message),
    ...(errorCodeOf(value) !== undefined ? { code: errorCodeOf(value) } : {}),
    ...(value.message.length > 500 ? { complete: false as const } : {}),
    ...((value instanceof LLMRateLimitError || value instanceof LLMQuotaError) && value.retryAfter !== undefined
      ? { retryAfter: value.retryAfter } : {}),
    ...(value instanceof LLMQuotaError && value.resetAtMs !== undefined ? { resetAtMs: value.resetAtMs } : {}),
    ...(value instanceof LLMTimeoutError ? { timeoutMs: value.timeoutMs } : {}),
    ...(value instanceof LLMContextExceededError
      ? { status: value.status, ...(value.inputBudget !== undefined ? { inputBudget: value.inputBudget } : {}) }
      : {}),
    ...(value instanceof LLMOutputBudgetExceededError
      ? {
        contextLimit: value.contextLimit,
        inputTokens: value.inputTokens,
        requestedMaxTokens: value.requestedMaxTokens,
        ...(value.inputBudget !== undefined ? { inputBudget: value.inputBudget } : {}),
      }
      : {}),
    ...(value instanceof LLMAllProvidersFailedError ? { failures: value.evidence } : {}),
    ...(value.cause !== undefined
      ? { cause: serializeErrorEvidence(value.cause, depth + 1, seen) }
      : {}),
  };
  seen.delete(value);
  return result;
}

/** 从同一 failure 构造 family/code/cause/候选证据，原始 Error 仍由 failures 保留。 */
export function makeLLMFailureEvidence(failure: LLMProviderFailure): LLMFailureEvidence {
  return {
    family: failure.errorClass ?? classifyLLMError(failure.error),
    provider: failure.provider,
    ...(failure.providerId !== undefined ? { providerId: failure.providerId } : {}),
    ...(failure.attemptIndex !== undefined ? { attemptIndex: failure.attemptIndex } : {}),
    ...(failure.localSkip !== undefined ? { localSkip: failure.localSkip } : {}),
    ...(errorCodeOf(failure.error) !== undefined ? { errorCode: errorCodeOf(failure.error) } : {}),
    cause: serializeErrorEvidence(failure.error),
  };
}

function serializedEvidenceComplete(evidence: SerializedErrorEvidence): boolean {
  return evidence.complete !== false
    && (evidence.cause === undefined || serializedEvidenceComplete(evidence.cause))
    && (evidence.failures === undefined || evidence.failures.every(failure => serializedEvidenceComplete(failure.cause)));
}

export class LLMAllProvidersFailedError extends Error {
  readonly code: OrchestratorErrorCode = 'LLM_ALL_PROVIDERS_FAILED';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();
  readonly failures: LLMProviderFailure[];
  readonly evidence: readonly LLMFailureEvidence[];

  constructor(failures: LLMProviderFailure[]) {
    const summary = failures
      .map(f => `${f.provider} (${f.error.message})`)
      .join(', ');
    super(
      `All LLM providers failed: ${summary}`,
    );
    this.name = this.constructor.name;
    this.failures = failures;
    this.evidence = failures.map(makeLLMFailureEvidence);
    this.context = { failures: failures.map(f => ({ provider: f.provider, error: f.error.message })) };
  }

  toJSON() {
    return {
      code: this.code,
      message: redactErrorText(this.message),
      context: {
        failures: this.failures.map(failure => ({
          provider: failure.provider,
          error: redactErrorText(failure.error.message),
        })),
      },
      evidenceVersion: 1,
      evidenceComplete: (this.cause === undefined || serializedEvidenceComplete(serializeErrorEvidence(this.cause)))
        && this.failures.every(failure =>
          failure.providerId !== undefined
          && failure.attemptIndex !== undefined
          && serializedEvidenceComplete(makeLLMFailureEvidence(failure).cause)),
      failures: this.evidence,
      ...(this.cause !== undefined && { cause: serializeErrorEvidence(this.cause) }),
    };
  }
}

/**
 * Circuit breaker open — 多 provider 编排状态机产生的拒绝错误（Phase 1722 Step F 归位）。
 * 仅 LLMOrchestrator 构造；provider adapter 不产生。extends Error（同 LLMAllProvidersFailedError 先例），
 * 镜像 LLMError 运行时字段（name/context/timestamp/toJSON）保持序列化行为；
 * classifyLLMError 显式分支保持历史 transient 分类不变。
 */
export class LLMCircuitBreakerOpenError extends Error {
  readonly code: OrchestratorErrorCode = 'LLM_CIRCUIT_BREAKER_OPEN';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();

  constructor(provider: string) {
    super(`Circuit breaker open for ${provider}`);
    this.name = this.constructor.name;
    this.context = { provider };
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

export type LLMErrorClass = 'permanent' | 'transient' | 'rate_limit' | 'abort' | 'context_exceeded' | 'quota' | 'unknown';

export function classifyLLMError(err: unknown): LLMErrorClass {
  // phase 690: context_exceeded 必须先于 LLMError 通用判定（subclass 关系）
  if (err instanceof LLMContextExceededError || err instanceof LLMOutputBudgetExceededError) return 'context_exceeded';
  if (err instanceof LLMAllProvidersFailedError) {
    const classes = err.failures.map(failure => failure.errorClass ?? classifyLLMError(failure.error));
    // phase 1776: 聚合归类顺序——transient 优先（可重试快）；全 permanent（无 quota）
    // 保持 permanent；rate_limit 次之（服务端 Retry-After 驱动）；含 quota → quota
    // （时间窗退避归 EventLoop quota 调度，不进配置类 blocked gate）。
    if (classes.some(c => c === 'transient')) return 'transient';
    if (classes.length > 0 && classes.every(c => c === 'permanent')) return 'permanent';
    if (classes.some(c => c === 'rate_limit')) return 'rate_limit';
    if (classes.some(c => c === 'quota')) return 'quota';
    if (classes.some(c => c === 'context_exceeded')) return 'context_exceeded';
    if (classes.some(c => c === 'abort')) return 'abort';
    return 'unknown';
  }
  // Phase 2037: L1 独占 provider 文本分类；L2 只消费 typed quota 证据。
  if (err instanceof LLMQuotaError) return 'quota';
  if (err instanceof LLMAuthError || err instanceof LLMModelNotFoundError || err instanceof LLMInvalidRequestError) return 'permanent';
  if (err instanceof LLMRateLimitError) return 'rate_limit';
  if (err instanceof LLMNetworkError || err instanceof LLMTimeoutError) return 'transient';
  if (err instanceof LLMCircuitBreakerOpenError) return 'transient';
  if (isAbortError(err)) return 'abort';
  if (err instanceof LLMError) return 'transient';
  return 'unknown';
}

/**
 * Context-exceeded 消费谓词（Phase 1959 §4.7）：只消费 L1 已构造的 typed evidence。
 *
 * - LLMContextExceededError / LLMOutputBudgetExceededError → true；
 * - LLMAllProvidersFailedError → failures 结构化递归（任一子错误是 context）；
 * - 普通 Error 文本一律 false —— provider 文本判定归 L1（pi-ai predicate），
 *   L2b 不再重复解析（边界收紧是有意的；raw text 出现说明 L1 typed 化有漏点）。
 */
export function isContextExceededError(err: unknown): boolean {
  if (err instanceof LLMContextExceededError || err instanceof LLMOutputBudgetExceededError) {
    return true;
  }
  if (err instanceof LLMAllProvidersFailedError) {
    return err.failures.some(failure => isContextExceededError(failure.error));
  }
  return false;
}

export type UserActionHint =
  | 'rotate_api_key'
  | 'switch_primary'
  | 'wait_retry_after'
  | 'check_quota'
  | 'check_endpoint'
  | 'check_network'
  | null;

export function getUserActionHint(err: unknown): UserActionHint {
  if (err instanceof LLMQuotaError) return 'check_quota';
  if (err instanceof LLMAuthError) return 'rotate_api_key';
  if (err instanceof LLMModelNotFoundError) return 'switch_primary';
  if (err instanceof LLMRateLimitError) return 'wait_retry_after';
  if (err instanceof LLMTimeoutError) return 'check_endpoint';
  if (err instanceof LLMNetworkError) return 'check_network';
  return null;
}

/**
 * 从 L1 typed error 提取 Retry-After 秒数；quota 与 rate-limit 共用 header 事实，
 * 禁止凭 error message 正则推导。provider reset 由独立字段消费，不混入 header。
 */
export function getRetryAfterSec(err: unknown): number | undefined {
  return err instanceof LLMRateLimitError || err instanceof LLMQuotaError ? err.retryAfter : undefined;
}

/** L1 已校验时区的 quota reset 下界；L2 不重新解析 provider 自然语言。 */
export function getQuotaResetAtMs(err: unknown): number | undefined {
  return err instanceof LLMQuotaError ? err.resetAtMs : undefined;
}
