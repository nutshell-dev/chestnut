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
import { formatErr } from '../foundation/utils/index.js';
import type { ClawId } from '../foundation/identity/index.js';
import { type ClawDir } from '../foundation/identity/index.js';


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

// Check if a claw has an active or paused contract.
// 用于 crash detection — paused contract 的 claw crash motion 也需要知道（可能要 resume）.
export function clawHasContract(clawDir: ClawDir, fsFactory: (baseDir: string) => FileSystem, audit?: AuditLog): boolean {
  return clawHasContractSub(clawDir, fsFactory, ['active', 'paused'], audit);
}

// phase 1482: Check if a claw has an ACTIVE contract only.
// 用于 inactivity timeout — paused 本就该停、不算 inactivity（root cause D 类 fix）.
export function clawHasActiveContract(clawDir: ClawDir, fsFactory: (baseDir: string) => FileSystem, audit?: AuditLog): boolean {
  return clawHasContractSub(clawDir, fsFactory, ['active'], audit);
}

function clawHasContractSub(
  clawDir: ClawDir,
  fsFactory: (baseDir: string) => FileSystem,
  subs: readonly string[],
  audit?: AuditLog,
): boolean {
  const fs = fsFactory(clawDir);
  for (const sub of subs) {
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

// ---- phase 1482: claw_inactivity FailureClass taxonomy ----

/**
 * Failure class for `claw_inactivity` watchdog notification.
 * 业主 own enum、由 既有 snapshot 数据派生（不需 NEW state collection）。
 *
 * - `daemon_stopped`: 进程不在跑（user 主动 stop 或 crash dedup'd）→ 重启
 * - `daemon_silent`:  进程跑、无 lastError、stream 静默 → 看 audit events tail
 * - `daemon_errored`: 进程跑、有 lastError → 看 lastError context
 *
 * Assembly motion guidance composer type-only import 此 enum、按 class switch
 * 1 primary action（DP「相关」derive / 1 primary action per sub-state）.
 */
export type FailureClass = 'daemon_stopped' | 'daemon_silent' | 'daemon_errored';

export interface DeriveFailureClassInput {
  daemonAlive: boolean;
  lastError: string | null | undefined;
}

export function deriveFailureClass(input: DeriveFailureClassInput): FailureClass {
  if (!input.daemonAlive) return 'daemon_stopped';
  if (input.lastError) return 'daemon_errored';
  return 'daemon_silent';
}

/** Body 字面按 failure_class 改、取代统一 "no progress for Nm" 误导措辞 (user 实战触发). */
export function formatInactivityBody(opts: {
  clawId: string;
  inactiveMin: number;
  notifyCount: number;     // displayCount (notifyCount + 1)
  failureClass: FailureClass;
  daemonStatus: 'running' | 'stopped';
  contract: string;
  inboxPending: number;
  outboxPending: number;
  lastError?: string | null;
}): string {
  const prefix = (() => {
    switch (opts.failureClass) {
      case 'daemon_stopped':
        return `Claw ${opts.clawId} daemon stopped, last activity ${opts.inactiveMin}m ago`;
      case 'daemon_silent':
        return `Claw ${opts.clawId} daemon running but no stream event for ${opts.inactiveMin}m`;
      case 'daemon_errored':
        return `Claw ${opts.clawId} daemon running with error ${opts.inactiveMin}m ago`;
    }
  })();
  let body = `${prefix} (notification #${opts.notifyCount}). Status: ${opts.daemonStatus}, contract: ${opts.contract}, inbox_pending: ${opts.inboxPending}, outbox_pending: ${opts.outboxPending}`;
  if (opts.lastError) body += `, last error: ${opts.lastError}`;
  return body;
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

export function gatherClawSnapshot(clawDir: ClawDir, fsFactory: (baseDir: string) => FileSystem, pm: ProcessLiveness, clawId: ClawId): ClawSnapshot {
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
