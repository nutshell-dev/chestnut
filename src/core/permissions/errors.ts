import { formatErr } from '../../foundation/node-utils/index.js';

export type PermissionErrorCode =
  | 'PERMISSION_DENIED'
  | 'PATH_NOT_IN_CLAW_SPACE'
  | 'WRITE_OPERATION_FORBIDDEN';

export class PermissionError extends Error {
  readonly code: PermissionErrorCode = 'PERMISSION_DENIED';
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

export type WriteForbiddenReason = 'system_readonly' | 'outside_allowlist';

export class PathNotInClawSpaceError extends PermissionError {
  readonly code: PermissionErrorCode = 'PATH_NOT_IN_CLAW_SPACE';

  constructor(path: string, clawDir: string) {
    super(
      `Path "${path}" is not within claw root`,
      { path, clawDir }
    );
  }
}

// Mirror of src/core/permissions/claw-permissions.ts BASE_WRITABLE_PATHS
// (foundation/ must not import core/; keep in sync manually)
const WRITABLE_ALLOWLIST_HINT =
  'MEMORY.md, memory/, USER.md, IDENTITY.md, SOUL.md, clawspace/, ' +
  'prompts/, skills/, inbox/, outbox/, tasks/, logs/';

function formatWriteForbiddenMessage(
  targetPath: string,
  reason: WriteForbiddenReason,
): string {
  switch (reason) {
    case 'system_readonly':
      return `Path "${targetPath}" cannot be written: target is a claw system path (read-only)`;
    case 'outside_allowlist':
      return `Path "${targetPath}" cannot be written: target is not in claw writable allowlist (${WRITABLE_ALLOWLIST_HINT})`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export class WriteOperationForbiddenError extends PermissionError {
  readonly code: PermissionErrorCode = 'WRITE_OPERATION_FORBIDDEN';

  constructor(targetPath: string, reason: WriteForbiddenReason) {
    super(
      formatWriteForbiddenMessage(targetPath, reason),
      { targetPath, reason }
    );
  }
}
