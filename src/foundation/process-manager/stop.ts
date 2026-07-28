import { kill as defaultKill, isAlive as defaultL1IsAlive, type ProcessStartTime } from '../process-exec/index.js';
import type { DaemonDir } from './types.js';
import { DAEMON_SHUTDOWN_GRACE_MS, PROCESS_STOP_POLL_INTERVAL_MS, SIGKILL_DEAD_VERIFY_GRACE_MS } from './constants.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { formatErr, newUuid } from '../node-utils/index.js';
import type { ProcessManagerContext } from './types.js';
import {
  inspectActive,
  inspectActivePid,
  inspectSpawning,
  inspectSpawningPid,
  retireGeneration,
  writeStopIntent,
  hasStopIntent,
} from './generation.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type StopProcessResult =
  | { kind: 'stopped'; pid: number; via: 'sigterm' | 'sigkill' }
  | { kind: 'intent_recorded' }
  | { kind: 'not_running' }
  | { kind: 'failed'; reason: string };

/**
 * Stop the daemon process for `daemonDir` using the generation directory protocol.
 *
 * Phase 1204 Step D/E：stop 按磁盘位置（active → spawning → retired）确定性处置，
 * 不再等待 lock、不读 legacy pid 文件。spawning 尚未写 PID 时记录 immutable stop
 * intent，parent 写 PID 后立即 abort。
 */
export async function stopProcess(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<boolean> {
  const result = await stopProcessDetailed(ctx, daemonDir);
  return result.kind === 'stopped' || result.kind === 'intent_recorded';
}

export async function stopProcessDetailed(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): Promise<StopProcessResult> {
  const l1IsAlive = ctx.l1IsAlive ?? defaultL1IsAlive;

  // 1. active generation：按 active PID 发信号，确认死亡后 retire。
  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=active`,
      `ctx=stop`,
      `reason=${ctx.audit.message(formatErr(active.cause))}`,
    );
    return { kind: 'failed', reason: `malformed active generation: ${formatErr(active.cause)}` };
  }
  if (active.status === 'ok') {
    const pidFact = inspectActivePid(ctx, daemonDir);
    if (pidFact.status === 'malformed') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
        `daemon_dir=${daemonDir}`,
        `dir=active`,
        `ctx=stop`,
        `file=pid`,
        `reason=${ctx.audit.message(formatErr(pidFact.cause))}`,
      );
      return { kind: 'failed', reason: `malformed active pid: ${formatErr(pidFact.cause)}` };
    }
    if (pidFact.status === 'none' || pidFact.record.generation_id !== active.record.generation_id) {
      return { kind: 'failed', reason: 'active generation pid fact missing or mismatched' };
    }
    if (!l1IsAlive(pidFact.record.pid, pidFact.record.start_time as ProcessStartTime | undefined)) {
      retireGeneration(ctx, daemonDir, { generationId: active.record.generation_id }, 'stopped', 'active');
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
        `daemon_dir=${daemonDir}`,
        `pid=${pidFact.record.pid}`,
        `via=already_dead`,
        `from=active`,
      );
      return { kind: 'stopped', pid: pidFact.record.pid, via: 'sigterm' };
    }
    return stopAndRetire(
      ctx,
      daemonDir,
      active.record.generation_id,
      pidFact.record.pid,
      pidFact.record.start_time as ProcessStartTime | undefined,
      'active',
    );
  }

  // 2. spawning generation：有 PID 直接杀；无 PID 写 stop intent 让 parent abort。
  const spawning = inspectSpawning(ctx, daemonDir);
  if (spawning.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=spawning`,
      `ctx=stop`,
      `reason=${ctx.audit.message(formatErr(spawning.cause))}`,
    );
    return { kind: 'failed', reason: `malformed spawning generation: ${formatErr(spawning.cause)}` };
  }
  if (spawning.status === 'ok') {
    const pidFact = inspectSpawningPid(ctx, daemonDir);
    if (pidFact.status === 'malformed') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
        `daemon_dir=${daemonDir}`,
        `dir=spawning`,
        `ctx=stop`,
        `file=pid`,
        `reason=${ctx.audit.message(formatErr(pidFact.cause))}`,
      );
      return { kind: 'failed', reason: `malformed spawning pid: ${formatErr(pidFact.cause)}` };
    }
    if (pidFact.status === 'ok' && pidFact.record.generation_id === spawning.record.generation_id) {
      if (!l1IsAlive(pidFact.record.pid, pidFact.record.start_time as ProcessStartTime | undefined)) {
        retireGeneration(ctx, daemonDir, { generationId: spawning.record.generation_id }, 'stopped', 'spawning');
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
          `daemon_dir=${daemonDir}`,
          `pid=${pidFact.record.pid}`,
          `via=already_dead`,
          `from=spawning`,
        );
        return { kind: 'stopped', pid: pidFact.record.pid, via: 'sigterm' };
      }
      return stopAndRetire(
        ctx,
        daemonDir,
        spawning.record.generation_id,
        pidFact.record.pid,
        pidFact.record.start_time as ProcessStartTime | undefined,
        'spawning',
      );
    }

    // spawning 已存在但 parent 还没写 PID：记录 stop intent，parent 写 PID 时 abort。
    const requestId = newUuid();
    const intent = writeStopIntent(ctx, daemonDir, requestId);
    if (intent.kind !== 'written') {
      return { kind: 'failed', reason: `failed to record stop intent: ${formatErr(intent.cause)}` };
    }
    return { kind: 'intent_recorded' };
  }

  // 3. 无 active/spawning generation：idempotent nothing-to-stop。
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.STOP_IDEMPOTENT,
    `daemon_dir=${daemonDir}`,
    `reason=no_generation`,
  );
  return { kind: 'not_running' };
}

async function stopAndRetire(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
  pid: number,
  startTime: ProcessStartTime | undefined,
  source: 'spawning' | 'active',
): Promise<StopProcessResult> {
  const l1IsAlive = ctx.l1IsAlive ?? defaultL1IsAlive;
  const kill = ctx.kill ?? defaultKill;

  let via: 'sigterm' | 'sigkill' = 'sigterm';
  try {
    kill(pid, 'TERM');

    const deadline = Date.now() + DAEMON_SHUTDOWN_GRACE_MS;
    while (Date.now() < deadline) {
      if (!l1IsAlive(pid, startTime)) break;
      await sleep(PROCESS_STOP_POLL_INTERVAL_MS);
    }

    if (l1IsAlive(pid, startTime)) {
      kill(pid, 'KILL');
      via = 'sigkill';
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_KILL_ESCALATED,
        `daemon_dir=${daemonDir}`,
        `pid=${pid}`,
      );
      const verifyDeadline = Date.now() + SIGKILL_DEAD_VERIFY_GRACE_MS;
      while (Date.now() < verifyDeadline) {
        if (!l1IsAlive(pid, startTime)) break;
        await sleep(PROCESS_STOP_POLL_INTERVAL_MS);
      }
      if (l1IsAlive(pid, startTime)) {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.STOP_PID_REMOVED_BEFORE_DEAD,
          `daemon_dir=${daemonDir}`,
          `pid=${pid}`,
          `grace_ms=${SIGKILL_DEAD_VERIFY_GRACE_MS}`,
        );
        return { kind: 'failed', reason: 'process survived SIGKILL' };
      }
    }
  } catch (err) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
      `daemon_dir=${daemonDir}`,
      `pid=${pid}`,
      `via=${via}`,
      `reason=${(err as NodeJS.ErrnoException).code || (err as Error).message}`,
    );
    return { kind: 'failed', reason: formatErr(err) };
  }

  const retired = retireGeneration(ctx, daemonDir, { generationId }, 'stopped', source);
  if (
    retired.kind !== 'retired' &&
    retired.kind !== 'collision' &&
    retired.kind !== 'no_generation'
  ) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
      `daemon_dir=${daemonDir}`,
      `pid=${pid}`,
      `reason=retire_failed_${retired.kind}`,
    );
    return { kind: 'failed', reason: `retire failed: ${retired.kind}` };
  }

  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
    `daemon_dir=${daemonDir}`,
    `pid=${pid}`,
    `via=${via}`,
    `from=${source}`,
  );
  return { kind: 'stopped', pid, via };
}

/** Parent spawn 路径调用：在子 PID 写入后检查是否有 stop intent。 */
export function shouldAbortSpawningForStop(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): boolean {
  return hasStopIntent(ctx.fs, daemonDir);
}
