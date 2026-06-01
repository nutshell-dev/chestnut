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

// ---- phase 1482: claw_inactivity FailureClass taxonomy + phase 2 reframe ----

/**
 * Failure class for `claw_inactivity` watchdog notification.
 * 业主 own enum、由 既有 snapshot 数据派生（不需 NEW state collection）。
 *
 * - `daemon_silent`:  进程跑、无 lastError、stream 静默 → 看 audit events tail
 * - `daemon_errored`: 进程跑、有 lastError → 看 lastError context
 *
 * phase 2 γ4 reframe: `daemon_stopped` class 移除 — dead daemon 归 `crash_notification` 覆盖
 * (两 type cover 互斥状态、0 dedup 重叠). inactivity 仅在 daemon ALIVE 时触发.
 *
 * Assembly motion guidance composer type-only import 此 enum、按 class switch
 * 1 primary action（DP「相关」derive / 1 primary action per sub-state）.
 */
export type FailureClass = 'daemon_silent' | 'daemon_errored';

export interface DeriveFailureClassInput {
  /** Must be true — inactivity 仅在 daemon alive 时调（caller guard 见 maybeCronClawInactivity） */
  daemonAlive: boolean;
  lastError: string | null | undefined;
}

export function deriveFailureClass(input: DeriveFailureClassInput): FailureClass {
  // phase 2 γ4: daemon_stopped 不再由本函数派生（caller 应已 guard daemonAlive=true）
  // 防御性 fallback: 若 caller 漏 guard 传入 daemonAlive=false → 按 silent 处理（lastError 仍优先）
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

// ---- phase 2 γ4: crash_notification CrashClass taxonomy ----

/**
 * Crash class for `crash_notification` watchdog notification.
 * 业主 own enum、由 clean-stop marker 探测决定。
 *
 * - `active_unexpected`: active contract + daemon dead + 无 clean-stop marker → 重启 daemon
 * - `active_user_stopped`: active contract + daemon dead + 有 clean-stop marker (user/system 主动 stop) → motion 知情即可
 *
 * paused contract crash 不触发本 type（caller 应 guard `clawHasActiveContract`）.
 * Assembly motion guidance composer type-only import 此 enum、按 class switch.
 */
export type CrashClass = 'active_unexpected' | 'active_user_stopped';

export interface DeriveCrashClassInput {
  hasCleanStopMarker: boolean;
}

export function deriveCrashClass(input: DeriveCrashClassInput): CrashClass {
  return input.hasCleanStopMarker ? 'active_user_stopped' : 'active_unexpected';
}

/** 读 `<clawDir>/clean-stop` marker 存在判定 (read-only / 不消费 marker / phase 1373 sub-3 + phase 2 γ4 per-claw 扩). */
export function hasCleanStopMarker(clawDir: ClawDir, fsFactory: (baseDir: string) => FileSystem): boolean {
  try {
    const fs = fsFactory(clawDir);
    return fs.existsSync('clean-stop');
  } catch {
    return false;
  }
}

/** Body 字面按 crash_class 改、取代统一 "process exited abnormally" 措辞. */
export function formatCrashBody(opts: {
  clawId: string;
  crashClass: CrashClass;
  contract: string;
  outboxPending: number;
  lastAuditEvents?: string[];
}): string {
  const prefix = (() => {
    switch (opts.crashClass) {
      case 'active_unexpected':
        return `Claw ${opts.clawId} unexpectedly stopped (active contract).`;
      case 'active_user_stopped':
        return `Claw ${opts.clawId} stopped via user CLI (active contract).`;
    }
  })();
  const eventsStr = opts.lastAuditEvents?.length
    ? `; last_events: ${opts.lastAuditEvents.map(e => e.replace(/\t/g, '|')).join(' >> ')}`
    : '';
  return `${prefix} contract: ${opts.contract}, outbox_pending: ${opts.outboxPending}${eventsStr}`;
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
