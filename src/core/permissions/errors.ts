import { ClawError, type ErrorCode } from '../../foundation/errors.js';

export type WriteForbiddenReason = 'system_readonly' | 'outside_allowlist';

export class PermissionError extends ClawError {
  readonly code: ErrorCode = 'PERMISSION_DENIED';
}

export class PathNotInClawSpaceError extends PermissionError {
  readonly code: ErrorCode = 'PATH_NOT_IN_CLAW_SPACE';

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
  readonly code: ErrorCode = 'WRITE_OPERATION_FORBIDDEN';

  constructor(targetPath: string, reason: WriteForbiddenReason) {
    super(
      formatWriteForbiddenMessage(targetPath, reason),
      { targetPath, reason }
    );
  }
}
