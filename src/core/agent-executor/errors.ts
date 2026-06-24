import { formatErr } from '../../foundation/node-utils/index.js';

export type AgentErrorCode =
  | 'MAX_STEPS_EXCEEDED'
  | 'CONSECUTIVE_PARSE_ERRORS_EXCEEDED'
  | 'CONSECUTIVE_MAX_TOKENS_TOOL_USE_EXCEEDED'
  | 'WALL_TIME_EXCEEDED';

export class AgentError extends Error {
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

export class ConsecutiveParseErrorsExceededError extends AgentError {
  constructor(maxErrors: number, toolNames: string) {
    super(
      'CONSECUTIVE_PARSE_ERRORS_EXCEEDED',
      `工具输入 JSON 连续解析失败 ${maxErrors} 次（工具: ${toolNames}），终止执行`,
      { maxErrors, toolNames }
    );
  }
}

export class ConsecutiveMaxTokensToolUseError extends AgentError {
  constructor(maxErrors: number) {
    super(
      'CONSECUTIVE_MAX_TOKENS_TOOL_USE_EXCEEDED',
      `LLM 连续 ${maxErrors} 次 max_tokens 截断 tool_use，终止执行。请减少 system prompt 或 tool schema 体积。`,
      { maxErrors }
    );
  }
}

export class WallTimeExceededError extends AgentError {
  constructor(deadlineMs: number, elapsedMs: number) {
    super(
      'WALL_TIME_EXCEEDED',
      `Wall-time deadline ${deadlineMs}ms exceeded (elapsed ${elapsedMs}ms)`,
      { deadlineMs, elapsedMs }
    );
  }
}
