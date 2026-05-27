/**
 * @module L4.Permissions
 * Claw permission policy (L4 业务 / phase377 从 L1 迁出 / phase430 彻底归 L4)
 *
 * Enforces access rules:
 * - System space (read-only): AGENTS.md, dialog/, config.yaml, .clawforum/, system/
 * - Claw writable space: MEMORY.md, memory/, USER.md, IDENTITY.md, SOUL.md,
 *   clawspace/, prompts/, skills/, inbox/, outbox/, tasks/queues/{pending,running,done,failed}, logs/
 * - Claw readable space: + contract/, tasks/queues/results/, tasks/sync/subagent/, tasks/sync/spawn/, tasks/sync/shadow/, tasks/subagents/
 * - Outside clawDir: denied (PathNotInClawSpaceError)
 *
 * Phase 1200: cross-claw access is managed by hub-and-spoke topology (motion routes);
 * PermissionChecker is caller-scoped, not target-scoped. Direct claw-to-claw
 * read/write is not enforced here — see foundation/file-tool/read.ts line 103-104.
 *
 * Phase430: PermissionChecker interface + createClawPermissionChecker 完全归 L4。
 * NodeFileSystem (L1) 0 PermissionChecker dep / 0 业务概念。
 * L4 caller (FileTool 等) 自治调 claw-permissions check 后 call fs。
 */

import * as path from 'path';
import {
  PathNotInClawSpaceError,
  WriteOperationForbiddenError,
} from '../../foundation/errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { PERMISSION_AUDIT_EVENTS } from './audit-events.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,
} from '../async-task-system/index.js';
import { CLAWSPACE_DIR } from '../../foundation/paths.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/permission.js';
import { type ClawDir } from '../../foundation/identity/index.js';
export type { PermissionChecker } from '../../foundation/tool-protocol/permission.js';


/**
 * System directories/files that are read-only for claws
 */
const SYSTEM_PATHS = [
  'AGENTS.md',
  'dialog',
  'config.yaml',
  '.clawforum',
  'system',
];

/**
 * Directories where claws can write（base paths / 不含 taskSyncDirs）
 * Phase 1335: task sync dirs 装配期 inject
 */
const BASE_WRITABLE_PATHS = [
  'MEMORY.md',
  'memory',
  'USER.md',
  'IDENTITY.md',
  'SOUL.md',
  CLAWSPACE_DIR,
  'prompts',
  'skills',
  'inbox',
  'outbox',
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,            // phase 512 / 子代理 workspace
  'logs',
];

export interface ClawPermissionOptions {
  /** Base directory for the claw */
  clawDir: ClawDir;

  /** System paths that should be read-only (default: SYSTEM_PATHS) */
  systemPaths?: string[];

  /** Whether to enforce strict mode (default: true) */
  strict?: boolean;

  /** Optional audit log for permission events */
  audit?: AuditLog;

  /** FileSystem for path resolution (symlink traversal guard) */
  fs?: FileSystem;

  /** Phase 1335: task sync directories injected at assembly time */
  taskSyncDirs?: readonly string[];
}

/**
 * Check if relative path matches any of the patterns
 * Matches complete path components only (not substrings)
 */
function matchesPathPatterns(
  relativePath: string,
  patterns: string[]
): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(p => p.length > 0);

  for (const pattern of patterns) {
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/\/$/, '');
    const patternParts = normalizedPattern.split('/').filter(p => p.length > 0);

    // Direct match
    if (normalized === normalizedPattern) {
      return true;
    }

    // Is or is within the pattern directory
    // e.g., pattern "dialog" matches "dialog/file.txt"
    if (parts.length >= patternParts.length) {
      const matchParts = parts.slice(0, patternParts.length);
      if (matchParts.join('/') === normalizedPattern) {
        return true;
      }
    }

  }

  return false;
}

/**
 * Get path relative to claw directory
 */
function getRelativeToClaw(
  clawDir: ClawDir,
  targetPath: string,
  fs?: FileSystem
): string | null {
  try {
    let resolvedClaw: string;
    let resolvedTarget: string;

    if (fs) {
      resolvedClaw = fs.resolve('.');
      resolvedTarget = fs.resolve(targetPath);
    } else {
      resolvedClaw = path.resolve(clawDir);
      resolvedTarget = path.resolve(targetPath);
    }

    if (
      resolvedTarget === resolvedClaw ||
      resolvedTarget.startsWith(resolvedClaw + path.sep)
    ) {
      return path.relative(resolvedClaw, resolvedTarget);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check read permission for a path
 * @throws PathNotInClawSpaceError if path is outside claw space
 */
function checkReadPermission(
  targetPath: string,
  options: ClawPermissionOptions
): void {
  const { clawDir, strict = true, audit } = options;

  // Non-strict mode allows everything
  if (!strict) {
    audit?.write(PERMISSION_AUDIT_EVENTS.STRICT_DISABLED,
      'Non-strict mode active — all permission checks bypassed');
    return;
  }

  // Check if within clawDir
  const relativePath = getRelativeToClaw(clawDir, targetPath, options.fs);

  if (relativePath !== null) {
    // Within clawDir - readable by default
    return;
  }

  // Denied
  throw new PathNotInClawSpaceError(targetPath, clawDir);
}

/**
 * Check write permission for a path
 * @throws PathNotInClawSpaceError if path is outside claw space
 * @throws WriteOperationForbiddenError if path is in read-only area
 */
function checkWritePermission(
  targetPath: string,
  options: ClawPermissionOptions
): void {
  const {
    clawDir,
    systemPaths = SYSTEM_PATHS,
    strict = true,
    audit,
  } = options;

  // Non-strict mode allows everything
  if (!strict) {
    audit?.write(PERMISSION_AUDIT_EVENTS.STRICT_DISABLED,
      'Non-strict mode active — all permission checks bypassed');
    return;
  }

  // Check if within clawDir
  const relativePath = getRelativeToClaw(clawDir, targetPath, options.fs);

  if (relativePath !== null) {
    const writablePaths = options.taskSyncDirs
      ? [...BASE_WRITABLE_PATHS, ...options.taskSyncDirs]
      : BASE_WRITABLE_PATHS;
    const isSystemPath = matchesPathPatterns(relativePath, systemPaths);
    const isWritablePath = matchesPathPatterns(relativePath, writablePaths);

    // Check system paths (read-only)
    if (isSystemPath) {
      throw new WriteOperationForbiddenError('write', 'system');
    }

    // Check writable paths
    if (isWritablePath) {
      return;
    }

    // fallthrough: deny by default (explicit allow list)
    if (!isSystemPath && !isWritablePath) {
      throw new WriteOperationForbiddenError('write', 'default');
    }

    return;
  }

  // Denied
  throw new PathNotInClawSpaceError(targetPath, clawDir);
}

/**
 * Create a Claw permission checker bound to a specific claw
 */
export function createClawPermissionChecker(
  options: ClawPermissionOptions,
): PermissionChecker {
  return {
    checkRead: (targetPath: string) => checkReadPermission(targetPath, options),
    checkWrite: (targetPath: string) => checkWritePermission(targetPath, options),

    /**
     * Resolve and validate a path
     * @returns Absolute path if valid
     * @throws PermissionError if invalid
     */
    resolveAndCheck(
      relativePath: string,
      operation: 'read' | 'write'
    ): string {
      const absolute = path.resolve(options.clawDir, relativePath);

      if (operation === 'read') {
        checkReadPermission(absolute, options);
      } else {
        checkWritePermission(absolute, options);
      }

      return absolute;
    },
  };
}
