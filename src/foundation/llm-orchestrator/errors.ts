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

import { formatErr } from '../node-utils/index.js';
import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMNetworkError,
  LLMTimeoutError,
  LLMContextExceededError,
  LLMOutputBudgetExceededError,
  LLMInvalidRequestError,
  isAbortError,
} from '../llm-provider/index.js';

type OrchestratorErrorCode = 'LLM_ALL_PROVIDERS_FAILED' | 'LLM_CIRCUIT_BREAKER_OPEN';

export class LLMAllProvidersFailedError extends Error {
  readonly code: OrchestratorErrorCode = 'LLM_ALL_PROVIDERS_FAILED';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();
  readonly failures: Array<{ provider: string; error: Error }>;

  constructor(failures: Array<{ provider: string; error: Error }>) {
    const summary = failures
      .map(f => `${f.provider} (${f.error.message})`)
      .join(', ');
    super(
      `All LLM providers failed: ${summary}`,
    );
    this.name = this.constructor.name;
    this.failures = failures;
    this.context = { failures: failures.map(f => ({ provider: f.provider, error: f.error.message })) };
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      ...(this.cause !== undefined && { cause: formatErr(this.cause) }),
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
    const classes = err.failures.map(failure => classifyLLMError(failure.error));
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
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // phase 1776: quota（用量/配额时间窗）先于 permanent 判定——5h 窗内重试必败、
    // 窗结束自动恢复：语义 = EventLoop 时间退避，非配置类永久错误。
    // 'usage limit' 覆盖 Kimi k3 5h 窗文案（"reached your 5-hour usage limit"）。
    if (msg.includes('quota') || msg.includes('usage limit') || msg.includes('insufficient') || msg.includes('credit') || msg.includes('billing')) {
      return 'quota';
    }
  }
  if (err instanceof LLMAuthError || err instanceof LLMModelNotFoundError || err instanceof LLMInvalidRequestError) return 'permanent';
  if (err instanceof LLMRateLimitError) return 'rate_limit';
  if (err instanceof LLMNetworkError || err instanceof LLMTimeoutError) return 'transient';
  if (err instanceof LLMCircuitBreakerOpenError) return 'transient';
  if (isAbortError(err)) return 'abort';
  if (err instanceof LLMError) return 'transient';
  return 'unknown';
}

/**
 * Broad context-exceeded detection. Handles three paths from the orchestrator:
 *   1. Single-provider LLMContextExceededError (orchestrator throw-through, instanceof)
 *   2. All-providers LLMError("...context_window_exceeded...") (streaming generator, regex)
 *   3. SDK-adapter non-standard error messages matching Anthropic/OpenAI context patterns (regex)
 *
 * Regex mirrors Runtime._isContextExceededError (src/core/runtime/runtime.ts:1226);
 * after this extraction, Runtime._isContextExceededError will delegate here.
 */
export function isContextExceededError(err: unknown): boolean {
  if (err instanceof LLMContextExceededError) return true;
  if (err instanceof Error) {
    const msg = err.message;
    return /maximum context length|context.{0,30}exceed|prompt is too long|reduce the length of/i.test(msg);
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
  if (err instanceof LLMAuthError) {
    const msg = err.message.toLowerCase();
    if (msg.includes('quota') || msg.includes('credit') || msg.includes('insufficient')) {
      return 'check_quota';
    }
    return 'rotate_api_key';
  }
  if (err instanceof LLMModelNotFoundError) return 'switch_primary';
  if (err instanceof LLMRateLimitError) return 'wait_retry_after';
  if (err instanceof LLMTimeoutError) return 'check_endpoint';
  if (err instanceof LLMNetworkError) return 'check_network';
  return null;
}

/**
 * Phase 1268 Step C: 从 typed LLMRateLimitError 提取 Retry-After 秒数。
 * 只允许 typed 字段，禁止凭 error message 正则推导；非 rate-limit / 无 header 返回 undefined。
 */
export function getRetryAfterSec(err: unknown): number | undefined {
  return err instanceof LLMRateLimitError ? err.retryAfter : undefined;
}
