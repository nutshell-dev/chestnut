import { ClawError, type ErrorCode } from '../errors.js';

export class ToolError extends ClawError {
  readonly code: ErrorCode = 'TOOL_EXECUTION_FAILED';
}

export class ToolTimeoutError extends ToolError {
  readonly code: ErrorCode = 'TOOL_TIMEOUT';

  constructor(toolName: string, timeoutMs: number) {
    super(
      `Tool "${toolName}" timed out after ${timeoutMs}ms`,
      { toolName, timeoutMs }
    );
  }
}
