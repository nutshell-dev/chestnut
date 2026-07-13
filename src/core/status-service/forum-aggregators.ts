/**
 * Forum-level status aggregators — pure data views for `chestnut status` CLI.
 *
 * Phase 1478 — 重塑 `chestnut status` 从全量 claw dump 到 system + active claws
 * 聚合视图。aggregator 与现有 per-claw `aggregators.ts` 平行（per-claw 是 contract/
 * task/storage 业务层、本模块是进程层 + 全局活跃概览）。
 *
 * 设计原则：
 * - 全 pure / 0 side effect except FS reads
 * - 时间相关字段算成 elapsed ms（uptime、lastActivityAgo）让 view 自含 / formatter 0 时钟依赖
 * - 数据源解析失败折进 view（undefined 字段）/ caller 决定如何呈现 / 不抛
 * - composite `computeForumStatusView` 接 deps 注入 ProcessManager / now / getStartTime
 *   方便测试 + 与 CLI 命令解耦
 */

import type { FileSystem } from '../../foundation/fs/index.js';

import { formatErr } from '../../foundation/node-utils/index.js';
import { ProcessManager, ProcessListUnavailable } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { listAuditFiles } from '../../foundation/audit/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { createInboxReader } from '../../foundation/messaging/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../claw-topology/index.js';
import type { ClawTopology } from '../claw-topology/index.js';

// ── Views ───────────────────────────────────────────────────────────────────

export interface SystemComponentView {
  alive: boolean;
  pid?: number;
  uptimeMs?: number;
  inboxUnread?: number;
  reason: string;
  warning?: string;
}

export type ActiveClawView =
  | { status: 'ok'; name: string; pid: number; uptimeMs?: number; lastActivityAgoMs?: number; inboxUnread?: number }
  | { status: 'error'; name: string; error: string };

export interface OrphansView {
  watchdog: number[];
  daemon: number[];
  error?: string;
}

export interface ForumStatusView {
  timestamp: string;
  system: {
    watchdog: SystemComponentView;
    motion: SystemComponentView;
  };
  activeClaws: ActiveClawView[];
  totalClawCount: number;
  orphans: OrphansView;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Compute process uptime in ms by reading OS process start time via `getStartTime`
 * (typically `getProcessStartTime` from process-exec, which uses `ps -o lstart=`).
 * Returns undefined on missing PID or unparseable start string.
 */
export function computeProcessUptimeMs(
  pid: number,
  now: number,
  getStartTime: (pid: number) => string | undefined,
): number | undefined {
  const raw = getStartTime(pid);
  if (raw === undefined) return undefined;
  const startMs = Date.parse(raw);
  if (Number.isNaN(startMs)) return undefined;
  const elapsed = now - startMs;
  return elapsed >= 0 ? elapsed : undefined;
}

/**
 * Count unread inbox messages for a claw (files in inbox/pending/).
 * Returns 0 when inbox dir does not exist.
 */
export async function computeClawInboxUnread(
  clawFs: FileSystem,
  audit: AuditLog = { write: () => {} } as unknown as AuditLog,
): Promise<number | undefined> {
  try {
    const inboxReader = createInboxReader(clawFs, audit, 'inbox');
    return await inboxReader.peekPendingCount();
  } catch {
    return undefined; // I/O error → unavailable
  }
}

/**
 * Read the last-activity timestamp from the claw's audit files tail.
 * Returns undefined when no audit files exist, all are empty, or last lines
 * are unparseable.
 *
 * Phase 172: multi-file aware — reads all audit files (audit.tsv + tick.tsv +
 * viewport.tsv) and takes the max timestamp across all tails. This fixes the
 * drift where tick/viewport activity was routed to separate files in phase 159
 * but last-activity only checked audit.tsv.
 *
 * Implementation: reads up to last 8KB per file (single tail window — enough
 * for any reasonable single audit row, ISO ts is ~30 chars). Audit row format:
 *   <ISO-timestamp>\tseq=N\t<type>\t<cols>...\n
 */
const AUDIT_TAIL_WINDOW_BYTES = 8 * 1024;

export function computeClawLastActivityAgoMs(clawFs: FileSystem, now: number): number | undefined {
  const files = listAuditFiles(clawFs, '.');
  if (files.length === 0) return undefined;

  let maxTs: number | undefined;

  for (const file of files) {
    try {
      if (!clawFs.existsSync(file.path)) continue;
      const size = clawFs.statSync(file.path).size;
      if (size === 0) continue;

      const start = Math.max(0, size - AUDIT_TAIL_WINDOW_BYTES);
      const tail = clawFs.readBytesSync(file.path, start, size);

      const text = tail.toString('utf8');
      // Strip trailing newline so the last meaningful row is the final non-empty line
      const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
      const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
      if (lastLine === '') continue;

      const tabIdx = lastLine.indexOf('\t');
      const tsRaw = tabIdx === -1 ? lastLine : lastLine.slice(0, tabIdx);
      const ts = Date.parse(tsRaw);
      if (Number.isNaN(ts)) continue;
      if (maxTs === undefined || ts > maxTs) {
        maxTs = ts;
      }
    } catch {
      // silent: single file read failure shouldn't break cross-file max
    }
  }

  if (maxTs === undefined) return undefined;
  const elapsed = now - maxTs;
  return elapsed >= 0 ? elapsed : 0;
}

// ── Composite view builder ──────────────────────────────────────────────────

export interface ForumStatusDeps {
  fsFactory: (baseDir: string) => FileSystem;
  baseDir: string; // workspace root containing .chestnut/claws/*
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  motionDir: string; // .chestnut/motion (for motion-side inbox)
  pm: ProcessManager;
  now: () => number;
  getStartTime: (pid: number) => string | undefined;
  watchdog: {
    pid: number | undefined;
    alive: boolean;
    entryPath: string;
  };
  daemonEntryPath: string;
}

export async function computeForumStatusView(deps: ForumStatusDeps): Promise<ForumStatusView> {
  const nowMs = deps.now();
  const timestamp = new Date(nowMs).toISOString();

  // ── System: watchdog ──
  const watchdog: SystemComponentView = {
    alive: deps.watchdog.alive,
    pid: deps.watchdog.pid,
    reason: deps.watchdog.alive ? 'alive' : 'stopped',
    uptimeMs:
      deps.watchdog.alive && deps.watchdog.pid !== undefined
        ? computeProcessUptimeMs(deps.watchdog.pid, nowMs, deps.getStartTime)
        : undefined,
  };

  // ── System: motion ──
  const motionStatus = deps.pm.getAliveStatus(resolveClawDaemonDir(MOTION_CLAW_ID));
  const motionFs = deps.fsFactory(deps.motionDir);
  const motion: SystemComponentView = {
    alive: motionStatus.alive,
    pid: motionStatus.pid,
    reason: motionStatus.reason,
    uptimeMs:
      motionStatus.alive && motionStatus.pid !== undefined
        ? computeProcessUptimeMs(motionStatus.pid, nowMs, deps.getStartTime)
        : undefined,
    inboxUnread: motionStatus.alive ? await computeClawInboxUnread(motionFs) : undefined,
  };

  // ── Active claws ──
  const activeClaws: ActiveClawView[] = [];
  let totalClawCount = 0;
  const trackedPids: number[] = [];
  if (motionStatus.pid !== undefined) trackedPids.push(motionStatus.pid);

  const allClawIds = deps.clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID);
  totalClawCount = allClawIds.length;

  for (const clawId of allClawIds) {
    try {
      const s = deps.pm.getAliveStatus(resolveClawDaemonDir(makeClawId(clawId)));
      if (!s.alive || s.pid === undefined) continue;
      trackedPids.push(s.pid);
      const location = deps.clawTopology.resolve(makeClawId(clawId));
      if (location.kind !== 'local') continue;
      const clawFs = deps.fsFactory(location.clawDir);
      activeClaws.push({
        status: 'ok',
        name: clawId,
        pid: s.pid,
        uptimeMs: computeProcessUptimeMs(s.pid, nowMs, deps.getStartTime),
        lastActivityAgoMs: computeClawLastActivityAgoMs(clawFs, nowMs),
        inboxUnread: await computeClawInboxUnread(clawFs),
      });
    } catch (err) {
      activeClaws.push({
        status: 'error',
        name: clawId,
        error: formatErr(err),
      });
    }
  }

  // ── Orphans ──
  const orphans = computeOrphans(deps.pm, deps.watchdog.entryPath, deps.daemonEntryPath, {
    watchdog: deps.watchdog.pid,
    trackedPids,
  });

  return {
    timestamp,
    system: { watchdog, motion },
    activeClaws,
    totalClawCount,
    orphans,
  };
}

export function computeOrphans(
  pm: ProcessManager,
  watchdogEntry: string,
  daemonEntry: string,
  exclude: { watchdog: number | undefined; trackedPids: number[] },
): OrphansView {
  try {
    const wdOrphans = findOrphansInternal(pm, watchdogEntry, [exclude.watchdog]);
    const daemonOrphans = findOrphansInternal(pm, daemonEntry, exclude.trackedPids);
    return { watchdog: wdOrphans, daemon: daemonOrphans };
  } catch (err) {
    if (err instanceof ProcessListUnavailable) {
      return { watchdog: [], daemon: [], error: 'process list unavailable' };
    }
    throw err;
  }
}

function findOrphansInternal(
  pm: ProcessManager,
  entryPath: string,
  excludePids: (number | undefined)[],
): number[] {
  const validExcludes = excludePids.filter((p): p is number => typeof p === 'number');
  return pm.findProcesses(entryPath).filter(p => !validExcludes.includes(p) && p !== process.pid);
}

/**
 * Find orphan process PIDs matching `entryPath`, excluding `excludePids` and
 * the current process. Returns [] gracefully on ProcessListUnavailable.
 */
export function findOrphans(
  pm: ProcessManager,
  entryPath: string,
  excludePids: (number | undefined)[],
): number[] {
  try {
    return findOrphansInternal(pm, entryPath, excludePids);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) return [];
    throw err;
  }
}
