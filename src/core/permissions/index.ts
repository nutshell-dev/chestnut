/**
 * @module L4.Permissions
 * Permissions module barrel
 */
export { createClawPermissionChecker } from './claw-permissions.js';
export type { ClawPermissionOptions } from './claw-permissions.js';

export { PERMISSION_AUDIT_EVENTS } from './audit-events.js';
export { PermissionError, PathNotInClawSpaceError, WriteOperationForbiddenError } from './errors.js';
export type { PermissionErrorCode } from './errors.js';
