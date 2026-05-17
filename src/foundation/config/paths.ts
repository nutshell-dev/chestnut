/**
 * @module L1.Config
 *
 * Path getters / phase 500 sub-file extraction
 */

import * as path from 'path';

// Re-export shared constants
export { CLAW_SUBDIRS } from '../../types/paths.js';

// Workspace root - 优先从环境变量获取（供 exec 子进程继承）
export function getWorkspaceRoot(): string {
  return process.env.CLAWFORUM_ROOT ?? process.cwd();
}

export function getGlobalConfigPath(): string {
  return path.join(getWorkspaceRoot(), '.clawforum', 'config.yaml');
}

/**
 * Validate identifier-class param (clawId / skillName / etc) against traversal.
 * @throws Error if name contains '/', '..', is empty, '.' or starts with '.'.
 */
function assertSafeClawId(name: string): void {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name.startsWith('.') ||
    name.includes('/') ||
    name.includes('\\') ||
    /[\x00-\x1f]/.test(name) ||
    name.includes('..')
  ) {
    throw new Error(`Invalid claw id: ${JSON.stringify(name)}`);
  }
}

export function getClawDir(name: string): string {
  assertSafeClawId(name);
  return path.join(getWorkspaceRoot(), '.clawforum', 'claws', name);
}

export function getMotionDir(): string {
  return path.join(getWorkspaceRoot(), '.clawforum', 'motion');
}

export function getClawforumRoot(): string {
  return path.join(getWorkspaceRoot(), '.clawforum');
}

export function resolveAgentDir(id: string): string {
  return id === 'motion' ? getMotionDir() : getClawDir(id);
}

export function getClawConfigPath(name: string): string {
  return path.join(getClawDir(name), 'config.yaml');
}
