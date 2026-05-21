/**
 * Shared path constants + runtime path resolution — system-level directory
 * structure convention (M#3 single owner).
 *
 * foundation/paths.ts is the canonical location for all path knowledge.
 */

import * as path from 'path';

// ── Path constants ──

export const CLAWS_DIR = 'claws' as const;
export const CLAWSPACE_DIR = 'clawspace' as const;
export const STATUS_SUBDIR = 'status' as const;

export const CLAW_SUBDIRS = [
  'dialog',
  'dialog/archive',
  'inbox/pending',
  'inbox/done',
  'inbox/failed',
  'outbox/pending',
  'outbox/done',
  'outbox/failed',
  'tasks/queues/pending',
  'tasks/queues/running',
  'tasks/queues/done',
  'tasks/queues/failed',
  'tasks/queues/results',
  'tasks/sync/exec',
  'tasks/sync/write',
  'tasks/sync/subagent',
  'tasks/sync/spawn',
  'tasks/sync/shadow',
  'tasks/subagents',
  'memory',
  'contract',
  'skills',
  CLAWSPACE_DIR,
  'logs',
  STATUS_SUBDIR,
] as const;

// ── Runtime path resolution ──

/** Workspace root — prefers CLAWFORUM_ROOT env var (inherited by exec child processes). */
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
