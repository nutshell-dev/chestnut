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
 * Phase430: PermissionChecker interface + createClawPermissionChecker 完全归 L4。
 * NodeFileSystem (L1) 0 PermissionChecker dep / 0 业务概念。
 * L4 caller (FileTool 等) 自治调 claw-permissions check 后 call fs。
 */

import * as path from 'path';
import { realpathSync } from 'node:fs';
import {
  PathNotInClawSpaceError,
  WriteOperationForbiddenError,
} from '../../types/errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { PERMISSION_AUDIT_EVENTS } from './audit-events.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
} from '../../types/paths.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../subagent/index.js';
import { TASKS_SYNC_SPAWN_DIR } from '../spawn-system/index.js';
import { TASKS_SYNC_SHADOW_DIR } from '../shadow-system/index.js';
import { TASKS_SYNC_EXEC_DIR } from '../../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../../foundation/file-tool/index.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_SUBAGENTS_DIR } from '../../core/async-task-system/index.js';
import { CLAWSPACE_DIR } from '../../types/paths.js';
import type { PermissionChecker } from '../../types/permission.js';
export type { PermissionChecker } from '../../types/permission.js';


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
 * Directories where claws can write
 */
const WRITABLE_PATHS = [
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
  TASKS_SUBAGENTS_DIR,            // phase 512 / 子代理 workspace（α 简化 / 所有 callerType 等价 / 升 β 推 r+1+）
  TASKS_SYNC_EXEC_DIR,             // phase 536 / sync exec scratch
  TASKS_SYNC_WRITE_DIR,            // phase 536 / sync write scratch
  TASKS_SYNC_SUBAGENT_DIR,         // phase 536 + 764 / sync L4 直调 L3 lifecycle
  TASKS_SYNC_SPAWN_DIR,            // phase 766 spawn 工具自身 sync 路径
  TASKS_SYNC_SHADOW_DIR,             // phase 767 shadow 工具自身 sync 路径
  'logs',
];

export interface ClawPermissionOptions {
  /** Base directory for the claw */
  clawDir: string;

  /** System paths that should be read-only (default: SYSTEM_PATHS) */
  systemPaths?: string[];

  /** Whether to enforce strict mode (default: true) */
  strict?: boolean;

  /** Optional audit log for permission events */
  audit?: AuditLog;
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
 * Resolve symlinks; fallback by walking up to the nearest existing directory
 * and concatenating the unresolved suffix (mirror node-fs.ts:121-126 pattern).
 */
function safeRealpath(p: string): string {
  const absolute = path.resolve(p);
  try {
    return realpathSync(absolute);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      let dir = absolute;
      while (dir !== path.dirname(dir)) {
        dir = path.dirname(dir);
        try {
          const realDir = realpathSync(dir);
          return path.join(realDir, path.relative(dir, absolute));
        } catch {
          // silent: walking up to find existing parent directory for realpath fallback
        }
      }
      return absolute; // fallback to lexical (nothing exists)
    }
    return absolute;
  }
}

/**
 * Get path relative to claw directory
 */
function getRelativeToClaw(
  clawDir: string,
  targetPath: string
): string | null {
  try {
    const resolvedClaw = safeRealpath(clawDir);
    const resolvedTarget = safeRealpath(targetPath);

    if (
      resolvedTarget === resolvedClaw ||
      resolvedTarget.startsWith(resolvedClaw + path.sep)
    ) {
      return path.relative(resolvedClaw, resolvedTarget);
    }

    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err; // EACCES, EIO propagate
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
  const relativePath = getRelativeToClaw(clawDir, targetPath);

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
  const relativePath = getRelativeToClaw(clawDir, targetPath);

  if (relativePath !== null) {
    const isSystemPath = matchesPathPatterns(relativePath, systemPaths);
    const isWritablePath = matchesPathPatterns(relativePath, WRITABLE_PATHS);

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
