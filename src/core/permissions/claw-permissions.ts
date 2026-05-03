/**
 * @module L4.Permissions
 * Claw permission policy (L4 业务 / phase377 从 L1 迁出 / phase430 彻底归 L4)
 *
 * Enforces access rules:
 * - System space (read-only): AGENTS.md, dialog/, config.yaml, .clawforum/, system/
 * - Claw writable space: MEMORY.md, memory/, USER.md, IDENTITY.md, SOUL.md,
 *   clawspace/, prompts/, skills/, inbox/, outbox/, tasks/{pending,running,done,failed}, logs/
 * - Claw readable space: + contract/, tasks/results/
 * - Outside clawDir: denied (PathNotInClawSpaceError)
 *
 * Phase430: PermissionChecker interface + createClawPermissionChecker 完全归 L4。
 * NodeFileSystem (L1) 0 PermissionChecker dep / 0 业务概念。
 * L4 caller (FileTool 等) 自治调 claw-permissions check 后 call fs。
 */

import * as path from 'path';
import {
  PathNotInClawSpaceError,
  WriteOperationForbiddenError,
} from '../../types/errors.js';
import { TASKS_RUNNING_DIR, TASKS_DONE_DIR } from '../../types/paths.js';
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
  'clawspace',
  'prompts',
  'skills',
  'inbox',
  'outbox',
  'tasks/pending',
  TASKS_RUNNING_DIR,
  TASKS_DONE_DIR,
  'tasks/failed',
  'logs',
];

export interface ClawPermissionOptions {
  /** Base directory for the claw */
  clawDir: string;

  /** System paths that should be read-only (default: SYSTEM_PATHS) */
  systemPaths?: string[];

  /** Whether to enforce strict mode (default: true) */
  strict?: boolean;
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

    // Check if any parent directory matches
    for (let i = 1; i <= parts.length; i++) {
      const partial = parts.slice(0, i).join('/');
      if (partial === normalizedPattern) {
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
  clawDir: string,
  targetPath: string
): string | null {
  try {
    const resolvedClaw = path.resolve(clawDir);
    const resolvedTarget = path.resolve(targetPath);

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
  const { clawDir, strict = true } = options;

  // Non-strict mode allows everything
  if (!strict) {
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
    strict = true
  } = options;

  // Non-strict mode allows everything
  if (!strict) {
    return;
  }

  // Check if within clawDir
  const relativePath = getRelativeToClaw(clawDir, targetPath);

  if (relativePath !== null) {
    // Check system paths (read-only)
    if (matchesPathPatterns(relativePath, systemPaths)) {
      throw new WriteOperationForbiddenError('write', 'system');
    }

    // Check writable paths
    if (matchesPathPatterns(relativePath, WRITABLE_PATHS)) {
      return;
    }

    // By default, allow writes within clawDir but outside system paths
    // This includes subdirectories like skills/, memory/, etc.
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
