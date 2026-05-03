/**
 * @module L6a.WatchdogUtils
 * @layer L6a 应用层（Watchdog 工具函数）
 * @depends L1.FileSystem, L2.AuditLog, L2.Stream
 * @consumers L6a.Watchdog
 * @contract design/modules/l6_watchdog.md
 *
 * Watchdog 工具函数 — 提取以便测试。
 */

/**
 * Watchdog utility functions — extracted for testability
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FileSystem } from '../foundation/fs/types.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { readAll, STREAM_FILE } from '../foundation/stream/index.js';
import { LLM_OUTPUT_EVENTS } from '../foundation/stream/types.js';
import { CONTRACT_DIR } from '../types/paths.js';

// Parse stream.jsonl, return the timestamp of the last event and the last error message
export interface ClawActivityInfo {
  lastEventMs: number | null;  // most recent ts from any LLM output event
  lastError: string | null;    // error message when the last terminal event was turn_error
                               // only cleared by turn_end
}

export async function getClawActivityInfo(
  clawFs: FileSystem,
  audit: AuditLog,
): Promise<ClawActivityInfo> {
  try {
    const events = await readAll(clawFs, STREAM_FILE, audit);

    let lastEventMs: number | null = null;
    let lastError: string | null = null;

    for (const event of events) {
      const ts = typeof event.ts === 'number' ? event.ts : null;
      if (!ts) continue;

      // Direct LLM output counts as activity; turn_interrupted also counts
      // (claw was running but got interrupted — still an active state, not idle)
      if ((LLM_OUTPUT_EVENTS.has(event.type) || event.type === 'turn_interrupted') &&
          (lastEventMs === null || ts > lastEventMs)) {
        lastEventMs = ts;
      }

      // Only track terminal events to determine error state
      if (event.type === 'turn_end') {
        lastError = null;         // turn properly completed, clear error
      } else if (event.type === 'turn_error') {
        lastError = (event.error as string) ?? 'unknown error';
      }
      // turn_interrupted: neither clear nor set error
    }

    return { lastEventMs, lastError };
  } catch {
    return { lastEventMs: null, lastError: null };
  }
}

// Check if a claw has an active or paused contract
export function clawHasContract(clawDir: string): boolean {
  for (const sub of ['active', 'paused']) {
    try {
      const entries = fs.readdirSync(path.join(clawDir, CONTRACT_DIR, sub), { withFileTypes: true });
      if (entries.some(e => e.isDirectory())) return true;
    } catch { /* skip */ }
  }
  return false;
}

// ---- Phase 18: gatherClawSnapshot ----

export interface ClawSnapshot {
  status: 'running' | 'stopped';
  contract: string;       // 'active:<id>' | 'paused:<id>' | 'none'
  inboxPending: number;
  outboxPending: number;
}

/** Duck-typed subset of ProcessManager used by gatherClawSnapshot */
export interface ProcessLiveness {
  isAlive(id: string): boolean;
}

export function gatherClawSnapshot(clawDir: string, pm: ProcessLiveness, clawId: string): ClawSnapshot {
  const status = pm.isAlive(clawId) ? 'running' : 'stopped';

  let contract = 'none';
  for (const sub of ['active', 'paused']) {
    try {
      const entries = fs.readdirSync(path.join(clawDir, CONTRACT_DIR, sub), { withFileTypes: true });
      const dir = entries.find(e => e.isDirectory());
      if (dir) { contract = `${sub}:${dir.name}`; break; }
    } catch { /* skip */ }
  }

  const countMd = (dir: string) => {
    try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).length; } catch { return 0; }
  };
  const inboxPending = countMd(path.join(clawDir, 'inbox', 'pending'));
  const outboxPending = countMd(path.join(clawDir, 'outbox', 'pending'));

  return { status, contract, inboxPending, outboxPending };
}

// ---- Phase 18: inactivity backoff pure helpers ----

/** Returns effective notification interval (3x after first 2 notifications) */
export function getEffectiveInterval(notifyCount: number, timeoutMs: number): number {
  return notifyCount >= 2 ? timeoutMs * 3 : timeoutMs;
}

/** Returns true if claw made new progress that should reset the notify counter */
export function shouldResetNotifyCount(
  lastEventMs: number | null,
  lastNotified: number,
): boolean {
  return lastEventMs !== null && lastEventMs > lastNotified;
}
