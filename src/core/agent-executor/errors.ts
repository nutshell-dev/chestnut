import { ClawError, type ErrorCode } from '../../foundation/errors.js';

export class MaxStepsExceededError extends ClawError {
  readonly code: ErrorCode = 'MAX_STEPS_EXCEEDED';

  constructor(maxSteps: number) {
    super(
      `Maximum steps (${maxSteps}) exceeded`,
      { maxSteps }
    );
  }
}

export class ConsecutiveParseErrorsExceededError extends ClawError {
  readonly code: ErrorCode = 'CONSECUTIVE_PARSE_ERRORS_EXCEEDED';

  constructor(maxErrors: number, toolNames: string) {
    super(
      `工具输入 JSON 连续解析失败 ${maxErrors} 次（工具: ${toolNames}），终止执行`,
      { maxErrors, toolNames }
    );
  }
}

export class ConsecutiveMaxTokensToolUseError extends ClawError {
  readonly code: ErrorCode = 'CONSECUTIVE_MAX_TOKENS_TOOL_USE_EXCEEDED';

  constructor(maxErrors: number) {
    super(
      `LLM 连续 ${maxErrors} 次 max_tokens 截断 tool_use，终止执行。请减少 system prompt 或 tool schema 体积。`,
      { maxErrors }
    );
  }
}

export class WallTimeExceededError extends ClawError {
  readonly code: ErrorCode = 'WALL_TIME_EXCEEDED';

  constructor(deadlineMs: number, elapsedMs: number) {
    super(
      `Wall-time deadline ${deadlineMs}ms exceeded (elapsed ${elapsedMs}ms)`,
      { deadlineMs, elapsedMs }
    );
  }
}
