/**
 * @module L2.FileTool
 * Permission checker factory context (shared across file-tool modules)
 *
 * Holds the injected permissionCheckerFactory and caches per-clawDir instances.
 * Eliminates L2→L4 reverse dependency by receiving factory from Assembly.
 */

import type { PermissionChecker } from '../../types/permission.js';

let factory: ((clawDir: string) => PermissionChecker) | null = null;
const checkerCache = new Map<string, PermissionChecker>();

export function setPermissionCheckerFactory(f: (clawDir: string) => PermissionChecker): void {
  factory = f;
  checkerCache.clear(); // reset cache when factory changes
}

export function getChecker(clawDir: string): PermissionChecker {
  if (!factory) {
    throw new Error('FileTool: permissionCheckerFactory not injected (createFileTools missing deps)');
  }
  if (!checkerCache.has(clawDir)) {
    checkerCache.set(clawDir, factory(clawDir));
  }
  return checkerCache.get(clawDir)!;
}
