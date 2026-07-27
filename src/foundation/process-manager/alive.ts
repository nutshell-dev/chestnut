import { getPidFile } from './paths.js';
import type { DaemonDir } from './types.js';
import { isAlive as defaultL1IsAlive, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { formatErr } from "../node-utils/index.js";
import type { ProcessManagerContext } from './types.js';
import { isFileNotFound } from '../fs/index.js';

import { inspectActive, inspectActivePid } from './generation.js';


/**
 * Read the PID file at the given daemonDir and return its liveness verdict.
 *
 * Side-effect free probe (M#1): never deletes / repairs a stale pidfile —
 * cleanup is the responsibility of explicit stop/recovery paths.
 *
 * Phase 1204 Step C: generation active/pid.json 是 primary SoT；legacy
 * status/pid 作为过渡期 fallback（Step E 删除）。
 *
 * @param ctx        Process manager context (fs + audit)
 * @param daemonDir  Target daemon's owner directory
 * @returns          `alive`: liveness verdict; `reason`: human-readable cause;
 *                   `pid`: parsed PID when readable (regardless of liveness).
 *                   Unknown exceptions during the OS probe degrade to `alive=true`
 *                   to avoid killing a healthy process (PM-5).
 */
export function getAliveStatus(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): { alive: boolean; reason: string; pid?: number } {
  const generationAlive = getAliveStatusFromGeneration(ctx, daemonDir);
  if (generationAlive !== undefined) return generationAlive;
  return getAliveStatusLegacy(ctx, daemonDir);
}

/** generation active 有明确结论时返回结果；无 active/未迁移时返回 undefined 走 legacy fallback。 */
function getAliveStatusFromGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): { alive: boolean; reason: string; pid?: number } | undefined {
  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'malformed') {
    return { alive: false, reason: `malformed active generation: ${formatErr(active.cause)}` };
  }
  if (active.status === 'none') return undefined;

  const pid = inspectActivePid(ctx, daemonDir);
  if (pid.status === 'malformed') {
    return { alive: false, reason: `malformed active pid: ${formatErr(pid.cause)}` };
  }
  if (pid.status === 'none') {
    return { alive: false, reason: 'active generation without pid fact' };
  }

  if (pid.record.generation_id !== active.record.generation_id) {
    return { alive: false, reason: 'active pid generation mismatch' };
  }

  try {
    if ((ctx.l1IsAlive ?? defaultL1IsAlive)(pid.record.pid, pid.record.start_time as ProcessStartTime | undefined)) {
      return { alive: true, reason: `PID ${pid.record.pid}`, pid: pid.record.pid };
    }
    return { alive: false, reason: `PID ${pid.record.pid} not alive`, pid: pid.record.pid };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return { alive: false, reason: 'isAlive ESRCH', pid: pid.record.pid };
    }
    if (code === 'EPERM') {
      return { alive: true, reason: `isAlive EPERM (process exists, cannot probe)`, pid: pid.record.pid };
    }
    return { alive: true, reason: `isAlive probe failed: ${formatErr(err)}`, pid: pid.record.pid };
  }
}

function getAliveStatusLegacy(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): { alive: boolean; reason: string; pid?: number } {
  try {
    const pidFile = getPidFile(ctx, daemonDir);
    const content = ctx.fs.readSync(pidFile);
    const trimmed = content.trim();
    if (trimmed === '') {
      return { alive: false, reason: 'empty PID file' };
    }

    let pid: number;
    let startTime: ProcessStartTime | undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.pid === 'number') {
        pid = parsed.pid;
        startTime = typeof parsed.startTime === 'string' ? makeProcessStartTime(parsed.startTime) : undefined;
      } else {
        throw new Error('invalid JSON pidfile');
      }
    } catch {
      pid = parseInt(trimmed, 10);
      if (isNaN(pid)) {
        return { alive: false, reason: `invalid PID: "${trimmed}"` };
      }
    }

    // phase 458 (review N3-M): pid=0 sentinel = spawn 进行中、子 PID 未覆盖。
    // 跳过 kill 决策、视为「not alive 但 spawning」、防外部 stop 误杀父进程。
    // Phase 1204 后 parent 不再写 pid:0；保留 legacy 读路径兼容到 Step E。
    if (pid === 0) {
      return { alive: false, reason: 'spawning placeholder (pid=0)' };
    }

    if (!Number.isInteger(pid) || pid < 0) {
      return { alive: false, reason: `invalid PID: ${pid}` };
    }

    try {
      if ((ctx.l1IsAlive ?? defaultL1IsAlive)(pid, startTime)) {
        return { alive: true, reason: `PID ${pid}`, pid };
      }
      // M#1 probe ≠ delete：probe 不 mutate state、stale pidfile 清理归 stop/recovery 显式路径
      // 历史 deleteSync 引发 stop.ts isAliveByPidFile race（new4.P1.1 + new4.P2.1-C 同根 cluster phase 879）
      return { alive: false, reason: `PID ${pid} not alive` };
    } catch (err) {
      // Only ESRCH (no such process) is definite death.
      // EPERM: process exists but we cannot signal it → assume alive (conservative).
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return { alive: false, reason: 'isAlive ESRCH' };
      }
      if (code === 'EPERM') {
        return { alive: true, reason: `isAlive EPERM (process exists, cannot probe)`, pid };
      }
      // Any other probe error → conservative assume alive to avoid duplicate daemon startup.
      return { alive: true, reason: `isAlive probe failed: ${formatErr(err)}`, pid };
    }
  } catch (err) {
    if (isFileNotFound(err)) {
      return { alive: false, reason: 'no PID file' };
    }
    // Any other read error (EACCES, EIO, etc.) — cannot determine state.
    // Assume alive to prevent duplicate daemon startup.
    return { alive: true, reason: `PID file unreadable: ${formatErr(err)}` };
  }
}

export function isAliveByPidFile(ctx: ProcessManagerContext, daemonDir: DaemonDir): boolean {
  return getAliveStatus(ctx, daemonDir).alive;
}
