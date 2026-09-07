/**
 * @module L4.Permissions
 * Permissions module barrel
 */
export { createClawPermissionChecker } from './claw-permissions.js';
// phase 1783: 必需 audit sink 最小 capability type（真实 caller：assembly 注入 + 测试 fixture）
export type { PermissionAuditSink } from './claw-permissions.js';

export { PERMISSIONS_FILE_ROUTING } from './audit-events.js';
