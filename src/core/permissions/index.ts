/**
 * @module L4.Permissions
 * Permissions module barrel
 */
/**
 * @module L4.Permissions
 * Permissions module barrel.
 *
 * claw-permissions.ts is intentionally NOT re-exported: it imports from
 * async-task-system, and re-exporting through barrel creates
 * async-task-system → barrel → claw-permissions → async-task-system cycle.
 */
export type { CallerType, DispatchCallerType } from './caller-types.js';
export { callerTypeToProfile } from './caller-types.js';

export { PERMISSION_AUDIT_EVENTS } from './audit-events.js';
export { PermissionError, PathNotInClawSpaceError, WriteOperationForbiddenError } from './errors.js';
export type { PermissionErrorCode } from './errors.js';
