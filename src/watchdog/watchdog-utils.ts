/**
 * @module L6.WatchdogUtils
 * @layer L6 进程边界（Watchdog 工具函数）
 * @depends L1.FileSystem, L2.AuditLog, L2.Stream
 * @consumers L6.Watchdog
 * @contract design/modules/l6_watchdog.md
 *
 * Watchdog 工具函数 — 提取以便测试。
 */

/**
 * Watchdog utility functions — extracted for testability
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/types.js';
import { isFileNotFound } from '../foundation/fs/types.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { readAll, STREAM_FILE } from '../foundation/stream/index.js';
import { LLM_OUTPUT_EVENTS } from '../foundation/stream/index.js';
// NOTE: turn_start/turn_end/turn_error NOT included — only LLM output counts as activity
// If new stream event types are added, this set must be evaluated for inclusion
import { CONTRACT_DIR } from '../core/contract/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from '../foundation/utils/format.js';
import type { ClawId } from '../foundation/identity/index.js';


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
        // String() 防御 / 任何 truthy 转 string / null → 'null' / undefined → 'undefined' / Error → message ('Error: xxx')
        lastError = event.error != null ? String(event.error) : 'unknown error';
      }
      // turn_interrupted: neither clear nor set error
    }

    return { lastEventMs, lastError };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'FS_NOT_FOUND') {
      audit?.write(WATCHDOG_AUDIT_EVENTS.STREAM_READ_FAILED, `reason=${formatErr(err)}`);
    }
    return { lastEventMs: null, lastError: null };
  }
}

// Check if a claw has an active or paused contract
export function clawHasContract(clawDir: string, fsFactory: (baseDir: string) => FileSystem, audit?: AuditLog): boolean {
  const fs = fsFactory(clawDir);
  for (const sub of ['active', 'paused']) {
    try {
      const entries = fs.listSync(path.join(CONTRACT_DIR, sub), { includeDirs: true });
      if (entries.some(e => e.isDirectory)) return true;
    } catch (err) {
      if (isFileNotFound(err)) continue; // legitimate: contract dir not created yet
      audit?.write(
        WATCHDOG_AUDIT_EVENTS.CLAW_HAS_CONTRACT_CHECK_FAILED,
        `clawDir=${clawDir}`,
        `sub=${sub}`,
        `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return false;
}

// ---- Phase 18: gatherClawSnapshot ----

export interface ClawSnapshot {
  status: 'running' | 'stopped';
  contract: string;       // 'active:<id>' | 'paused:<id>' | 'none'
  inboxPending: number;
  outboxPending: number;
  // NEW additive optional forensic context (phase 1207 gap B)
  lastAuditEvents?: string[];   // last N audit events from claw audit.tsv
}

/** Duck-typed subset of ProcessManager used by gatherClawSnapshot */
export interface ProcessLiveness {
  isAlive(id: string): boolean;
}

const AUDIT_TAIL_N = 5;

export function gatherClawSnapshot(clawDir: string, fsFactory: (baseDir: string) => FileSystem, pm: ProcessLiveness, clawId: ClawId): ClawSnapshot {
  const status = pm.isAlive(clawId) ? 'running' : 'stopped';

  const fs = fsFactory(clawDir);
  let contract = 'none';
  for (const sub of ['active', 'paused']) {
    try {
      const entries = fs.listSync(path.join(CONTRACT_DIR, sub), { includeDirs: true });
      const dir = entries.find(e => e.isDirectory);
      if (dir) { contract = `${sub}:${dir.name}`; break; }
    } catch { /* silent: contract dir scan ENOENT is legitimate / skip */ }
  }

  const countMd = (dir: string) => {
    try { return fs.listSync(dir).filter(f => f.name.endsWith('.md')).length; } catch { return 0; }
  };
  const inboxPending = countMd(path.join('inbox', 'pending'));
  const outboxPending = countMd(path.join('outbox', 'pending'));

  // NEW: read claw audit.tsv tail for forensic context (phase 1207 gap B)
  let lastAuditEvents: string[] | undefined;
  try {
    const raw = fs.readSync('audit.tsv');
    const lines = raw.split('\n').filter(l => l.trim());
    lastAuditEvents = lines.slice(-AUDIT_TAIL_N);
  } catch { /* silent: audit.tsv ENOENT or corrupt: leave undefined optional */ }

  return { status, contract, inboxPending, outboxPending, lastAuditEvents };
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
