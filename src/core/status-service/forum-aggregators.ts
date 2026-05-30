/**
 * Forum-level status aggregators — pure data views for `clawforum status` CLI.
 *
 * Phase 1478 — 重塑 `clawforum status` 从全量 claw dump 到 system + active claws
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

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { isFileNotFound } from '../../foundation/fs/types.js';
import { ProcessManager, ProcessListUnavailable } from '../../foundation/process-manager/index.js';
import { CLAWS_DIR } from '../../foundation/paths.js';
import { AUDIT_FILE } from '../../foundation/audit/index.js';
import { INBOX_PENDING_DIR } from '../../foundation/messaging/index.js';
import { makeClawId } from '../../foundation/identity/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';

// ── Views ───────────────────────────────────────────────────────────────────

export interface SystemComponentView {
  alive: boolean;
  pid?: number;
  uptimeMs?: number;
  inboxUnread?: number;
  reason: string;
}

export interface ActiveClawView {
  name: string;
  pid: number;
  uptimeMs?: number;
  lastActivityAgoMs?: number;
  inboxUnread: number;
}

export interface OrphansView {
  watchdog: number[];
  daemon: number[];
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
export function computeClawInboxUnread(clawFs: FileSystem): number {
  try {
    if (!clawFs.existsSync(INBOX_PENDING_DIR)) return 0;
    return clawFs.listSync(INBOX_PENDING_DIR, { includeDirs: false }).length;
  } catch (err) {
    if (isFileNotFound(err)) return 0;
    throw err;
  }
}

/**
 * Read the last-activity timestamp from the claw's audit.tsv tail.
 * Returns undefined when file is absent, empty, or last line is unparseable.
 *
 * Implementation: reads up to last 8KB of file (single tail window — enough for
 * any reasonable single audit row, ISO ts is ~30 chars). Audit row format:
 *   <ISO-timestamp>\tseq=N\t<type>\t<cols>...\n
 */
const AUDIT_TAIL_WINDOW_BYTES = 8 * 1024;

export function computeClawLastActivityAgoMs(clawFs: FileSystem, now: number): number | undefined {
  let size: number;
  try {
    if (!clawFs.existsSync(AUDIT_FILE)) return undefined;
    size = clawFs.statSync(AUDIT_FILE).size;
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
  if (size === 0) return undefined;

  const start = Math.max(0, size - AUDIT_TAIL_WINDOW_BYTES);
  let tail: Buffer;
  try {
    tail = clawFs.readBytesSync(AUDIT_FILE, start, size);
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }

  const text = tail.toString('utf8');
  // Strip trailing newline so the last meaningful row is the final non-empty line
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
  if (lastLine === '') return undefined;

  const tabIdx = lastLine.indexOf('\t');
  const tsRaw = tabIdx === -1 ? lastLine : lastLine.slice(0, tabIdx);
  const ts = Date.parse(tsRaw);
  if (Number.isNaN(ts)) return undefined;
  const elapsed = now - ts;
  return elapsed >= 0 ? elapsed : 0;
}

// ── Composite view builder ──────────────────────────────────────────────────

export interface ForumStatusDeps {
  fsFactory: (baseDir: string) => FileSystem;
  baseDir: string; // workspace root containing .clawforum/claws/*
  motionDir: string; // .clawforum/motion (for motion-side inbox)
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

export function computeForumStatusView(deps: ForumStatusDeps): ForumStatusView {
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
  const motionStatus = deps.pm.getAliveStatus(MOTION_CLAW_ID);
  const motionFs = deps.fsFactory(deps.motionDir);
  const motion: SystemComponentView = {
    alive: motionStatus.alive,
    pid: motionStatus.pid,
    reason: motionStatus.reason,
    uptimeMs:
      motionStatus.alive && motionStatus.pid !== undefined
        ? computeProcessUptimeMs(motionStatus.pid, nowMs, deps.getStartTime)
        : undefined,
    inboxUnread: motionStatus.alive ? computeClawInboxUnread(motionFs) : undefined,
  };

  // ── Active claws ──
  const activeClaws: ActiveClawView[] = [];
  let totalClawCount = 0;
  const trackedPids: number[] = [];
  if (motionStatus.pid !== undefined) trackedPids.push(motionStatus.pid);

  const rootFs = deps.fsFactory(deps.baseDir);
  if (rootFs.existsSync(CLAWS_DIR)) {
    const entries = rootFs
      .listSync(CLAWS_DIR, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name);
    totalClawCount = entries.length;

    for (const name of entries) {
      const s = deps.pm.getAliveStatus(makeClawId(name));
      if (!s.alive || s.pid === undefined) continue;
      trackedPids.push(s.pid);
      const clawDir = path.join(deps.baseDir, CLAWS_DIR, name);
      const clawFs = deps.fsFactory(clawDir);
      activeClaws.push({
        name,
        pid: s.pid,
        uptimeMs: computeProcessUptimeMs(s.pid, nowMs, deps.getStartTime),
        lastActivityAgoMs: computeClawLastActivityAgoMs(clawFs, nowMs),
        inboxUnread: computeClawInboxUnread(clawFs),
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

function computeOrphans(
  pm: ProcessManager,
  watchdogEntry: string,
  daemonEntry: string,
  exclude: { watchdog: number | undefined; trackedPids: number[] },
): OrphansView {
  const wdOrphans = findOrphans(pm, watchdogEntry, [exclude.watchdog]);
  const daemonOrphans = findOrphans(pm, daemonEntry, exclude.trackedPids);
  return { watchdog: wdOrphans, daemon: daemonOrphans };
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
  const validExcludes = excludePids.filter((p): p is number => typeof p === 'number');
  try {
    return pm.findProcesses(entryPath).filter(p => !validExcludes.includes(p) && p !== process.pid);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) return [];
    throw err;
  }
}
