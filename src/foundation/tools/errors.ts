import { formatErr } from '../node-utils/index.js';

export type ToolErrorCode = 'TOOL_EXECUTION_FAILED' | 'TOOL_TIMEOUT';

export class ToolError extends Error {
  readonly code: ToolErrorCode = 'TOOL_EXECUTION_FAILED';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();

  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
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

export class ToolTimeoutError extends ToolError {
  readonly code: ToolErrorCode = 'TOOL_TIMEOUT';

  constructor(toolName: string, timeoutMs: number) {
    super(
      `Tool "${toolName}" timed out after ${timeoutMs}ms`,
      { toolName, timeoutMs }
    );
  }
}
