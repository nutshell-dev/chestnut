/**
 * @module L4.Permissions
 * Permissions module barrel
 */
export { createClawPermissionChecker } from './claw-permissions.js';

export { PERMISSION_AUDIT_EVENTS } from './audit-events.js';
export { PathNotInClawSpaceError, WriteOperationForbiddenError } from './errors.js';
export { PERMISSIONS_FILE_ROUTING } from './audit-events.js';
