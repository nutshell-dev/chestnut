import { formatErr } from '../../foundation/node-utils/index.js';

type AgentErrorCode =
  | 'MAX_STEPS_EXCEEDED'
  | 'CONSECUTIVE_PARSE_ERRORS_EXCEEDED'
  | 'CONSECUTIVE_MAX_TOKENS_TOOL_USE_EXCEEDED'
  | 'WALL_TIME_EXCEEDED';

class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();

  constructor(
    code: AgentErrorCode,
    message: string,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    if (cause) this.cause = cause;
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

export class MaxStepsExceededError extends AgentError {
  constructor(maxSteps: number) {
    super(
      'MAX_STEPS_EXCEEDED',
      `Maximum steps (${maxSteps}) exceeded`,
      { maxSteps }
    );
  }
}

/**
 * phase 1856 (AE-D4): 计数语义为 strike（自上次成功步起累计、另类失败不重置），
 * 非严格「连续」。类名/code 保留「Consecutive」为对外错误标识兼容（改名属另立行）。
 */
export class ConsecutiveParseErrorsExceededError extends AgentError {
  constructor(maxErrors: number, toolNames: string) {
    super(
      'CONSECUTIVE_PARSE_ERRORS_EXCEEDED',
      `工具输入 JSON 解析失败累计 ${maxErrors} 次（自上次成功起；工具: ${toolNames}），终止执行`,
      { maxErrors, toolNames }
    );
  }
}

/**
 * phase 1856 (AE-D4): strike 语义（同 ConsecutiveParseErrorsExceededError 注记）。
 */
export class ConsecutiveMaxTokensToolUseError extends AgentError {
  constructor(maxErrors: number) {
    super(
      'CONSECUTIVE_MAX_TOKENS_TOOL_USE_EXCEEDED',
      `LLM 已累计 ${maxErrors} 次（自上次成功起）max_tokens 截断 tool_use，终止执行。请减少 system prompt 或 tool schema 体积。`,
      { maxErrors }
    );
  }
}

/**
 * phase 1856 (AE-D11): 字段/文案同步为 budget 语义 —— per-loop wall-time 预算
 * （自 loop 起始计时、仅每 step 顶部检查，非硬中断；硬限制归 AbortSignal owner）。
 */
export class WallTimeExceededError extends AgentError {
  constructor(budgetMs: number, elapsedMs: number) {
    super(
      'WALL_TIME_EXCEEDED',
      `Wall-time budget ${budgetMs}ms exceeded (elapsed ${elapsedMs}ms)`,
      { budgetMs, elapsedMs }
    );
  }
}

/**
 * Phase 1956 Step C：agent loop 控制终止判据单源——max steps / wall time /
 * parse-limit / max-tokens-tool-use。这类终止发生在若干完整 step 之后，
 * 属可恢复失败：只结算当前 step（failed_step_discarded），
 * 不是未知系统故障（不得判 recovery_required）。
 * EventLoop 的 isAgentLoopCrashError 与本判据同源（delegate）。
 */
export function isAgentLoopTerminationError(err: unknown): boolean {
  return err instanceof MaxStepsExceededError
      || err instanceof WallTimeExceededError
      || err instanceof ConsecutiveParseErrorsExceededError
      || err instanceof ConsecutiveMaxTokensToolUseError;
}
