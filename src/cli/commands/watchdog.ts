/**
 * Watchdog daemon
 * Checks motion liveness every 30s, with a built-in simple cron
 */

import * as fs from 'fs';
import { existsSync } from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { SpawnOptions } from '../../foundation/process-manager/index.js';
import { setTimeout } from 'timers/promises';
import { getMotionDir, loadGlobalConfig } from '../config.js';
import { ProcessManager } from '../../foundation/process-manager/index.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { AuditWriter } from '../../foundation/audit/writer.js';
import { writeInboxMessage } from '../../utils/inbox-writer.js';
import { type ClawActivityInfo, LLM_OUTPUT_EVENTS, getClawActivityInfo, clawHasContract, getContractCreatedMs, type ClawSnapshot, type ProcessLiveness, gatherClawSnapshot, getEffectiveInterval, shouldResetNotifyCount } from './watchdog-utils.js';

// Get the .clawforum/ directory (CLAWFORUM_ROOT takes priority)
function getClawforumDir(): string {
  return path.dirname(getMotionDir());
}

/**
 * Returns the absolute path to the watchdog entry script for this installation.
 * Used as the pgrep pattern to scope process operations to the current install.
 */
export function getWatchdogEntryPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const bundleEntry = path.join(thisDir, 'watchdog-entry.js');
  return existsSync(bundleEntry)
    ? bundleEntry
    : path.resolve(thisDir, '..', '..', '..', 'dist', 'watchdog-entry.js');
}

// PID file path
function getWatchdogPidFile(): string {
  return path.join(getClawforumDir(), 'watchdog.pid');
}

/**
 * Create a ProcessManager dedicated to Motion
 */
function createMotionPM(): ProcessManager {
  const baseDir = path.dirname(getMotionDir());
  const nfs = new NodeFileSystem({ baseDir, enforcePermissions: false });
  return new ProcessManager(nfs, baseDir, (id) => {
    if (id === 'motion') return path.join(baseDir, 'motion');
    return path.join(baseDir, 'claws', id);
  });
}

// Watchdog PID management
function writeWatchdogPid(pid: number): void {
  const root = process.env.CLAWFORUM_ROOT ?? process.cwd();
  fs.writeFileSync(getWatchdogPidFile(), JSON.stringify({ pid, root }), 'utf-8');
}

function removeWatchdogPid(): void {
  try {
    fs.unlinkSync(getWatchdogPidFile());
  } catch {
    // ignore
  }
}

export function getWatchdogPid(): number | null {
  try {
    const content = fs.readFileSync(getWatchdogPidFile(), 'utf-8');
    const parsed = JSON.parse(content);
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

export function isWatchdogAlive(): boolean {
  try {
    const content = fs.readFileSync(getWatchdogPidFile(), 'utf-8');
    const { pid, root } = JSON.parse(content);
    if (typeof pid !== 'number') return false;
    const currentRoot = process.env.CLAWFORUM_ROOT ?? process.cwd();
    if (root !== currentRoot) {
      removeWatchdogPid();
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    removeWatchdogPid();
    return false;
  }
}

// Logging
function log(message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(logLine.trim());

  try {
    const logDir = path.join(getClawforumDir(), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'watchdog.log'), logLine, 'utf-8');
  } catch {
    // Fallback: already output to stdout above
  }
}

// Write an inbox message (YAML frontmatter .md format)
function writeWatchdogInboxMessage(type: string, content: Record<string, unknown>): void {
  const inboxDir = path.join(getMotionDir(), 'inbox', 'pending');
  const body = (content.message as string) ?? JSON.stringify(content);
  writeInboxMessage({
    inboxDir,
    type: `watchdog_${type}`,
    source: 'watchdog',
    priority: 'high',
    body,
    idPrefix: `${Date.now()}_${type}`,
    filenameTag: `watchdog_${type}`,
  });
}

// Cron state
const lastInactivityNotified: Map<string, number> = new Map();
const clawPreviouslyAlive: Map<string, boolean> = new Map();
const inactivityNotifyCount: Map<string, number> = new Map();  // consecutive notification count, used for backoff

interface WatchdogState {
  lastInactivityNotified: Record<string, number>;
  inactivityNotifyCount: Record<string, number>;
}

function getWatchdogStateFile(): string {
  return path.join(getClawforumDir(), 'watchdog-state.json');
}

function loadWatchdogState(): void {
  try {
    const raw = fs.readFileSync(getWatchdogStateFile(), 'utf-8');
    const state = JSON.parse(raw) as WatchdogState;
    for (const [k, v] of Object.entries(state.lastInactivityNotified ?? {})) {
      lastInactivityNotified.set(k, v);
    }
    for (const [k, v] of Object.entries(state.inactivityNotifyCount ?? {})) {
      inactivityNotifyCount.set(k, v);
    }
  } catch {
    // 首次启动或文件损坏 — 从空状态开始
  }
}

function saveWatchdogState(): void {
  const state: WatchdogState = {
    lastInactivityNotified: Object.fromEntries(lastInactivityNotified),
    inactivityNotifyCount: Object.fromEntries(inactivityNotifyCount),
  };
  try {
    fs.writeFileSync(getWatchdogStateFile(), JSON.stringify(state, null, 2));
  } catch (err) {
    log(`[watchdog] Failed to save state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Global config (loaded lazily on first access)
let globalConfigCache: ReturnType<typeof loadGlobalConfig> | null = null;
function getGlobalConfig() {
  if (!globalConfigCache) {
    globalConfigCache = loadGlobalConfig();
  }
  return globalConfigCache;
}

// Check for claws with an active contract but no progress for a long time, and send a reminder
export function maybeCronClawInactivity(pm: ProcessManager): void {
  const timeoutMs = getGlobalConfig().watchdog?.claw_inactivity_timeout_ms ?? 300000;
  const clawsDir = path.join(getClawforumDir(), 'claws');
  if (!fs.existsSync(clawsDir)) return;

  // 清理已不存在的 claw 的 Map 条目
  const existingClawIds = new Set(fs.readdirSync(clawsDir).filter(id => {
    try {
      return fs.statSync(path.join(clawsDir, id)).isDirectory();
    } catch {
      return false;
    }
  }));
  for (const id of lastInactivityNotified.keys()) {
    if (!existingClawIds.has(id)) {
      lastInactivityNotified.delete(id);
      inactivityNotifyCount.delete(id);
    }
  }

  const now = Date.now();
  for (const clawId of fs.readdirSync(clawsDir)) {
    try {
      const clawDir = path.join(clawsDir, clawId);

      // Has an active contract?
      if (!clawHasContract(clawDir)) continue;

      // Parse stream.jsonl to get real progress
      const { lastEventMs, lastError } = getClawActivityInfo(clawDir);

      // Merge with contract creation time to handle contract recreation scenario
      const contractCreatedMs = getContractCreatedMs(clawDir);
      const referenceMs = Math.max(lastEventMs ?? 0, contractCreatedMs ?? 0) || null;
      if (referenceMs === null) continue;

      // Not yet timed out
      if (now - referenceMs < timeoutMs) continue;

      // Reset count if claw has made new progress since last notification
      const lastNotified = lastInactivityNotified.get(clawId) ?? 0;
      if (shouldResetNotifyCount(referenceMs, lastNotified)) {
        inactivityNotifyCount.set(clawId, 0);
      }

      const notifyCount = inactivityNotifyCount.get(clawId) ?? 0;

      // Backoff interval: first 2 notifications use timeoutMs, from the 3rd onward use 3x
      const effectiveInterval = getEffectiveInterval(notifyCount, timeoutMs);
      if (now - lastNotified < effectiveInterval) continue;

      // Collect snapshot info
      const snapshot = gatherClawSnapshot(clawDir, pm, clawId);
      const inactiveMin = Math.round((now - referenceMs) / 60000);

      // Body without directives: pure factual data (including notification number)
      const displayCount = notifyCount + 1;
      let body = `Claw ${clawId} no progress for ${inactiveMin}m (notification #${displayCount}). Status: ${snapshot.status}, contract: ${snapshot.contract}, inbox_pending: ${snapshot.inboxPending}, outbox_pending: ${snapshot.outboxPending}`;
      if (lastError) body += `, last error: ${lastError}`;

      log(`[watchdog] Claw ${clawId} no progress ${inactiveMin}m (notify #${displayCount}) with active contract${lastError ? ` (last error: ${lastError})` : ''}`);
      writeWatchdogInboxMessage('claw_inactivity', {
        message: body,
        claw_id: clawId,
        inactive_ms: now - referenceMs,
        status: snapshot.status,
        contract: snapshot.contract,
        inbox_pending: snapshot.inboxPending,
        outbox_pending: snapshot.outboxPending,
        notify_count: displayCount,
        as_of: new Date().toISOString(),
        ...(lastError ? { last_error: lastError } : {}),
      });
      inactivityNotifyCount.set(clawId, displayCount);
      lastInactivityNotified.set(clawId, now);
    } catch (err) {
      log(`[watchdog] Error checking claw ${clawId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Detect claw process crashes and notify motion
function maybeCronClawCrash(pm: ProcessManager): void {
  const clawsDir = path.join(getClawforumDir(), 'claws');
  if (!fs.existsSync(clawsDir)) return;

  // 清理已不存在的 claw 的 Map 条目
  const existingClawIds = new Set(fs.readdirSync(clawsDir).filter(id => {
    try {
      return fs.statSync(path.join(clawsDir, id)).isDirectory();
    } catch {
      return false;
    }
  }));
  for (const id of clawPreviouslyAlive.keys()) {
    if (!existingClawIds.has(id)) {
      clawPreviouslyAlive.delete(id);
    }
  }

  for (const clawId of fs.readdirSync(clawsDir)) {
    const clawDir = path.join(clawsDir, clawId);
    const currentlyAlive = pm.isAlive(clawId);
    const wasAlive = clawPreviouslyAlive.get(clawId);

    if (wasAlive === true && !currentlyAlive) {
      // Only notify motion when there is an active/paused contract (no notification needed if claw stops without a contract)
      if (!clawHasContract(clawDir)) {
        log(`[watchdog] Claw ${clawId} stopped (no active contract, skipping notification)`);
        clawPreviouslyAlive.set(clawId, currentlyAlive);
        continue;
      }
      log(`[watchdog] Claw ${clawId} crashed (was alive, now stopped)`);

      // Collect snapshot info
      const snapshot = gatherClawSnapshot(clawDir, pm, clawId);
      const body = `contract: ${snapshot.contract}, outbox_pending: ${snapshot.outboxPending}`;

      writeInboxMessage({
        inboxDir: path.join(getMotionDir(), 'inbox', 'pending'),
        type: 'crash_notification',
        source: clawId,
        priority: 'high',
        body,
        filenameTag: 'claw_crash',
      });
    }

    clawPreviouslyAlive.set(clawId, currentlyAlive);
  }
}

// Daemon main loop
export async function daemonCommand(): Promise<void> {
  log('[watchdog] Daemon starting...');
  
  writeWatchdogPid(process.pid);
  loadWatchdogState();   // 恢复通知状态
  log('[watchdog] State loaded.');
  
  // Create auditWriter for watchdog
  const auditMaxSizeMb = getGlobalConfig().audit?.retention?.max_size_mb ?? null;
  const auditWriter = new AuditWriter(
    new NodeFileSystem({ baseDir: getClawforumDir(), enforcePermissions: false }),
    'audit.tsv',
    auditMaxSizeMb,
  );
  auditWriter.write('watchdog_start');
  
  let stopped = false;
  
  // Create Motion ProcessManager (reused across loop iterations)
  const pm = createMotionPM();
  
  process.on('SIGTERM', () => {
    log('[watchdog] Received SIGTERM, shutting down...');
    stopped = true;
    removeWatchdogPid();
    auditWriter.write('watchdog_stop');
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    log('[watchdog] Received SIGINT, shutting down...');
    stopped = true;
    removeWatchdogPid();
    auditWriter.write('watchdog_stop');
    process.exit(0);
  });
  
  // Motion restart failure tracking for backoff
  let motionRestartFailures = 0;

  while (!stopped) {
    // 1. Check motion liveness
    const status = pm.getAliveStatus('motion');
    
    // watchdog_check: 枚举所有存活进程
    const aliveIds: string[] = [];
    if (status.alive) aliveIds.push('motion');
    const clawsBaseDir = path.join(getClawforumDir(), 'claws');
    if (existsSync(clawsBaseDir)) {
      for (const id of fs.readdirSync(clawsBaseDir)) {
        try {
          if (fs.statSync(path.join(clawsBaseDir, id)).isDirectory() && pm.isAlive(id)) {
            aliveIds.push(id);
          }
        } catch {
          // ignore
        }
      }
    }
    auditWriter.write('watchdog_check', `alive=${aliveIds.join(',')}`);
    
    if (!status.alive) {
      log(`[watchdog] motion down (${status.reason}), restarting...`);
      auditWriter.write('watchdog_restart_triggered', 'motion');
      log(`[watchdog] motion down (${status.reason}), restarting...`);
      try {
        // First clean up any stale PID file that may exist
        await pm.stop('motion').catch((e) => {
          log(`[watchdog] Failed to clean up motion before restart: ${e instanceof Error ? e.message : String(e)}`);
        });
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const daemonEntryPath = path.resolve(thisDir, '..', '..', 'daemon-entry.js');
        const clawforumDir = getClawforumDir();
        const pid = await pm.spawn('motion', {
          command: 'node',
          args: [daemonEntryPath, 'motion'],
          logFile: path.join(getMotionDir(), 'logs', 'daemon.log'),
          env: { ...process.env, CLAWFORUM_ROOT: path.dirname(clawforumDir) } as Record<string, string | undefined>,
        });
        log(`[watchdog] motion restarted (PID=${pid})`);
        auditWriter.write('process_spawn', 'motion', `pid=${pid}`);
        motionRestartFailures = 0;  // Success, reset counter
      } catch (err) {
        if (err instanceof Error && err.message.includes('already running')) {
          // 另一个 watchdog 实例已经启动了 motion，不算失败
          log(`[watchdog] motion already started by another instance`);
          motionRestartFailures = 0;
        } else {
          motionRestartFailures++;
          auditWriter.write('process_spawn_failed', 'motion', `err=${err instanceof Error ? err.message : String(err)}`);
          log(`[watchdog] FAILED to restart motion (failure #${motionRestartFailures}): ${err}`);
        }
      }
    } else {
      motionRestartFailures = 0;  // Motion healthy, reset counter
    }
    
    // 2. Cron checks (disk_check moved to CronRunner in daemon.ts)
    maybeCronClawInactivity(pm);
    maybeCronClawCrash(pm);
    saveWatchdogState();   // 持久化通知状态（每 tick 一次）
    
    // 3. Sleep with backoff on consecutive failures (max 5 minutes)
    const intervalMs = getGlobalConfig().watchdog?.interval_ms ?? 30000;
    const backoffMs = motionRestartFailures > 0
      ? Math.min(intervalMs * Math.pow(2, motionRestartFailures - 1), 5 * 60 * 1000)
      : intervalMs;
    await setTimeout(backoffMs);
  }
}

// Start command
export async function startCommand(): Promise<void> {
  const watchdogEntryPath = getWatchdogEntryPath();

  // 幂等：本 workspace 的 watchdog 已在运行则直接返回
  if (isWatchdogAlive()) {
    console.log(`Watchdog already running (PID: ${getWatchdogPid()})`);
    return;
  }

  // spawn watchdog，显式传 CLAWFORUM_ROOT
  const clawforumRoot = process.env.CLAWFORUM_ROOT ?? process.cwd();
  const proc = spawn('node', [watchdogEntryPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLAWFORUM_ROOT: clawforumRoot },
  });
  proc.unref();

  // 等待 PID 文件写入
  let attempts = 0;
  while (!isWatchdogAlive() && attempts < 30) {
    await setTimeout(100);
    attempts++;
  }

  const pid = getWatchdogPid();
  if (pid) {
    console.log(`Watchdog started (PID: ${pid})`);
  } else {
    console.log('Watchdog may have failed to start');
  }
}

// Stop command
export async function stopCommand(): Promise<void> {
  const pid = getWatchdogPid();
  
  if (!pid || !isWatchdogAlive()) {
    console.log('Watchdog is not running');
    removeWatchdogPid();
    return;
  }
  
  console.log(`Stopping watchdog (PID: ${pid})...`);
  
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.log('Failed to send SIGTERM:', err);
  }
  
  // Wait up to 5s
  let attempts = 0;
  while (isWatchdogAlive() && attempts < 50) {
    await setTimeout(100);
    attempts++;
  }
  
  if (isWatchdogAlive()) {
    console.log('Watchdog still alive, sending SIGKILL...');
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      console.log('Failed to send SIGKILL:', err);
    }
    await setTimeout(500);
  }
  
  removeWatchdogPid();
  console.log('Watchdog stopped');
}
