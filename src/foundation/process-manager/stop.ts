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
  inspectRetiredGeneration,
  retireGeneration,
  writeStopIntent,
  hasStopIntentForGeneration,
  getRetiredDirFor,
} from './generation.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type StopProcessResult =
  | { kind: 'stopped'; pid: number; via: 'sigterm' | 'sigkill' | 'already_dead' }
  | { kind: 'intent_recorded' }
  | { kind: 'not_running' }
  | { kind: 'failed'; reason: string };

interface TargetLocation {
  source: 'spawning' | 'active';
  generationId: string;
  pid?: number;
  startTime?: ProcessStartTime;
}

/**
 * Stop the daemon process for `daemonDir` using the generation directory protocol.
 *
 * Phase 1204 Step F：每个 stop request 先绑定调用时观察到的目标 generation 并持久化
 * immutable stop intent，然后按 generation identity（而非固定磁盘位置）追踪处置。
 * 目标在 spawning → active 之间移动时会被重读并继续处置；槽位出现不同 generation
 * 或目标无 retired 证据即消失时 fail-closed。
 */
export async function stopProcess(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<boolean> {
  const result = await stopProcessDetailed(ctx, daemonDir);
  return result.kind === 'stopped' || result.kind === 'intent_recorded';
}

export async function stopProcessDetailed(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): Promise<StopProcessResult> {
  const initial = inspectTarget(ctx, daemonDir);

  if (initial.kind === 'malformed_active') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=active`,
      `ctx=stop_target_lookup`,
      `reason=${ctx.audit.message(formatErr(initial.cause))}`,
    );
    return { kind: 'failed', reason: `malformed active generation: ${formatErr(initial.cause)}` };
  }
  if (initial.kind === 'malformed_spawning') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=spawning`,
      `ctx=stop_target_lookup`,
      `reason=${ctx.audit.message(formatErr(initial.cause))}`,
    );
    return { kind: 'failed', reason: `malformed spawning generation: ${formatErr(initial.cause)}` };
  }
  if (initial.kind === 'none') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.STOP_IDEMPOTENT,
      `daemon_dir=${daemonDir}`,
      `reason=no_generation`,
    );
    return { kind: 'not_running' };
  }
  if (initial.kind === 'foreign') {
    // 槽位已有另一个 generation：迟到 stop 不得触碰 fresh generation。
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.STOP_LATE_TARGET_MISMATCH,
      `daemon_dir=${daemonDir}`,
      `observed_generation=${initial.observedGenerationId}`,
      `expected_generation=${initial.expectedGenerationId}`,
    );
    return {
      kind: 'failed',
      reason: `late stop: slot held by different generation (${initial.observedGenerationId})`,
    };
  }

  // 有目标 generation：先写绑定该 generation 的 immutable intent。
  const requestId = newUuid();
  const intent = writeStopIntent(ctx, daemonDir, requestId, initial.generationId, initial.source);
  if (intent.kind !== 'written') {
    return { kind: 'failed', reason: `failed to record stop intent: ${formatErr(intent.cause)}` };
  }

  return handleTarget(ctx, daemonDir, initial);
}

function inspectTarget(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
):
  | { kind: 'active' | 'spawning'; source: 'active' | 'spawning'; generationId: string; pid?: number; startTime?: ProcessStartTime }
  | { kind: 'none' }
  | { kind: 'foreign'; expectedGenerationId: string; observedGenerationId: string }
  | { kind: 'malformed_active'; cause: unknown }
  | { kind: 'malformed_spawning'; cause: unknown } {
  // 稳定空检测：状态只会从 spawning → active 单向移动。若第一次 active 为空后、
  // spawning 也为空，必须再读一次 active，防止 generation 恰在两次读取间 move。
  const active1 = inspectActiveLocation(ctx, daemonDir);
  if (active1.kind !== 'none') return active1;

  const spawning = inspectSpawningLocation(ctx, daemonDir);
  if (spawning.kind !== 'none') return spawning;

  const active2 = inspectActiveLocation(ctx, daemonDir);
  return active2;
}

function inspectActiveLocation(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
):
  | { kind: 'active'; source: 'active'; generationId: string; pid?: number; startTime?: ProcessStartTime }
  | { kind: 'none' }
  | { kind: 'foreign'; expectedGenerationId: string; observedGenerationId: string }
  | { kind: 'malformed_active'; cause: unknown } {
  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'malformed') return { kind: 'malformed_active', cause: active.cause };
  if (active.status === 'none') return { kind: 'none' };

  const pidFact = inspectActivePid(ctx, daemonDir);
  if (pidFact.status === 'malformed') return { kind: 'malformed_active', cause: pidFact.cause };
  if (pidFact.status === 'ok' && pidFact.record.generation_id === active.record.generation_id) {
    return {
      kind: 'active',
      source: 'active',
      generationId: active.record.generation_id,
      pid: pidFact.record.pid,
      startTime: pidFact.record.start_time as ProcessStartTime | undefined,
    };
  }
  // active generation 存在但 pid fact 缺失/不匹配：按 foreign 处理，不猜状态
  return {
    kind: 'foreign',
    expectedGenerationId: active.record.generation_id,
    observedGenerationId: pidFact.status === 'ok' ? pidFact.record.generation_id : 'missing_pid',
  };
}

function inspectSpawningLocation(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
):
  | { kind: 'spawning'; source: 'spawning'; generationId: string; pid?: number; startTime?: ProcessStartTime }
  | { kind: 'none' }
  | { kind: 'foreign'; expectedGenerationId: string; observedGenerationId: string }
  | { kind: 'malformed_spawning'; cause: unknown } {
  const spawning = inspectSpawning(ctx, daemonDir);
  if (spawning.status === 'malformed') return { kind: 'malformed_spawning', cause: spawning.cause };
  if (spawning.status === 'none') return { kind: 'none' };

  const pidFact = inspectSpawningPid(ctx, daemonDir);
  if (pidFact.status === 'malformed') return { kind: 'malformed_spawning', cause: pidFact.cause };
  if (pidFact.status === 'none') {
    return {
      kind: 'spawning',
      source: 'spawning',
      generationId: spawning.record.generation_id,
    };
  }
  if (pidFact.record.generation_id === spawning.record.generation_id) {
    return {
      kind: 'spawning',
      source: 'spawning',
      generationId: spawning.record.generation_id,
      pid: pidFact.record.pid,
      startTime: pidFact.record.start_time as ProcessStartTime | undefined,
    };
  }
  return {
    kind: 'foreign',
    expectedGenerationId: spawning.record.generation_id,
    observedGenerationId: pidFact.record.generation_id,
  };
}

async function handleTarget(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  target: TargetLocation,
): Promise<StopProcessResult> {
  const l1IsAlive = ctx.l1IsAlive ?? defaultL1IsAlive;

  // spawning 尚无 PID：intent 已足够，parent 写 PID 时会 abort。
  if (target.source === 'spawning' && target.pid === undefined) {
    return { kind: 'intent_recorded' };
  }

  if (target.pid === undefined) {
    return { kind: 'failed', reason: 'stop target has no pid' };
  }

  // 写 intent 后重读目标位置（可能在 spawning → active 之间移动）。
  const current = locateGeneration(ctx, daemonDir, target.generationId);
  if (current.kind === 'retired') {
    if (!retiredIdentityMatches(ctx, daemonDir, target.generationId)) {
      return {
        kind: 'failed',
        reason: `target generation ${target.generationId} retired directory does not match identity`,
      };
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.STOP_TARGET_RELOCATED,
      `daemon_dir=${daemonDir}`,
      `target_generation=${target.generationId}`,
      `current_location=retired`,
    );
    return { kind: 'stopped', pid: target.pid, via: 'already_dead' };
  }
  if (current.kind === 'foreign') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.STOP_LATE_TARGET_MISMATCH,
      `daemon_dir=${daemonDir}`,
      `target_generation=${target.generationId}`,
      `observed_generation=${current.observedGenerationId}`,
    );
    return {
      kind: 'failed',
      reason: `late stop: slot held by different generation (${current.observedGenerationId})`,
    };
  }
  if (current.kind === 'missing') {
    return {
      kind: 'failed',
      reason: `target generation ${target.generationId} disappeared without retired evidence`,
    };
  }

  if (!l1IsAlive(current.pid, current.startTime)) {
    const disposition = retireStoppedGeneration(ctx, daemonDir, target.generationId, current.source);
    if (disposition.kind !== 'retired') {
      return disposition;
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
      `daemon_dir=${daemonDir}`,
      `pid=${current.pid}`,
      `via=already_dead`,
      `from=${current.source}`,
    );
    return { kind: 'stopped', pid: current.pid, via: 'already_dead' };
  }

  return stopAndRetire(ctx, daemonDir, target.generationId, current);
}

function locateGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
):
  | { kind: 'spawning' | 'active'; pid: number; startTime: ProcessStartTime | undefined; source: 'spawning' | 'active' }
  | { kind: 'retired' }
  | { kind: 'missing' }
  | { kind: 'foreign'; observedGenerationId: string } {
  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'ok') {
    const pidFact = inspectActivePid(ctx, daemonDir);
    if (pidFact.status === 'ok' && pidFact.record.generation_id === generationId) {
      return {
        kind: 'active',
        source: 'active',
        pid: pidFact.record.pid,
        startTime: pidFact.record.start_time as ProcessStartTime | undefined,
      };
    }
    return {
      kind: 'foreign',
      observedGenerationId: active.record.generation_id,
    };
  }
  const spawning = inspectSpawning(ctx, daemonDir);
  if (spawning.status === 'ok') {
    const pidFact = inspectSpawningPid(ctx, daemonDir);
    if (pidFact.status === 'ok' && pidFact.record.generation_id === generationId) {
      return {
        kind: 'spawning',
        source: 'spawning',
        pid: pidFact.record.pid,
        startTime: pidFact.record.start_time as ProcessStartTime | undefined,
      };
    }
    return {
      kind: 'foreign',
      observedGenerationId: spawning.record.generation_id,
    };
  }
  if (ctx.fs.existsSync(getRetiredDirFor(daemonDir, generationId))) {
    return { kind: 'retired' };
  }
  return { kind: 'missing' };
}

function retiredIdentityMatches(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
): boolean {
  const inspection = inspectRetiredGeneration(ctx, daemonDir, generationId);
  return inspection.status === 'ok' && inspection.record.generation_id === generationId;
}

/**
 * 将目标 generation retire 到 retired/<generation-id>。处理 locate 与 move 之间的
 * spawning → active 单向移动：从 spawning retire 得到 no_generation 时，按 identity
 * 重读 active 并再 retire；从 active retire 丢失或无 retired 证据时 fail-closed。
 */
function retireStoppedGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
  source: 'spawning' | 'active',
): { kind: 'retired' } | { kind: 'failed'; reason: string } {
  const first = retireGeneration(ctx, daemonDir, { generationId }, 'stopped', source);
  if (first.kind === 'retired') {
    return { kind: 'retired' };
  }

  if (first.kind === 'no_generation') {
    if (source === 'spawning') {
      // 唯一允许的后续移动是 spawning → active；重读一次 active。
      const active = inspectActive(ctx, daemonDir);
      if (active.status === 'ok' && active.record.generation_id === generationId) {
        const pidFact = inspectActivePid(ctx, daemonDir);
        if (pidFact.status === 'ok' && pidFact.record.generation_id === generationId) {
          const second = retireGeneration(ctx, daemonDir, { generationId }, 'stopped', 'active');
          if (second.kind === 'retired') {
            return { kind: 'retired' };
          }
          if (second.kind === 'collision' && retiredIdentityMatches(ctx, daemonDir, generationId)) {
            return { kind: 'retired' };
          }
          return { kind: 'failed', reason: `retire active after move failed: ${second.kind}` };
        }
      }
      if (retiredIdentityMatches(ctx, daemonDir, generationId)) {
        return { kind: 'retired' };
      }
      return {
        kind: 'failed',
        reason: `target generation ${generationId} moved out of spawning but not to active or retired`,
      };
    }
    // source === 'active'：已定位到 active 后丢失，只能由 retired 证据证明成功。
    if (retiredIdentityMatches(ctx, daemonDir, generationId)) {
      return { kind: 'retired' };
    }
    return {
      kind: 'failed',
      reason: `target generation ${generationId} disappeared from active without retired evidence`,
    };
  }

  if (first.kind === 'collision') {
    if (retiredIdentityMatches(ctx, daemonDir, generationId)) {
      return { kind: 'retired' };
    }
    return { kind: 'failed', reason: `retire collision and retired identity mismatch for ${generationId}` };
  }

  return { kind: 'failed', reason: `retire failed: ${first.kind}` };
}

async function stopAndRetire(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
  current: { kind: 'spawning' | 'active'; pid: number; startTime: ProcessStartTime | undefined; source: 'spawning' | 'active' },
): Promise<StopProcessResult> {
  const l1IsAlive = ctx.l1IsAlive ?? defaultL1IsAlive;
  const kill = ctx.kill ?? defaultKill;

  let via: 'sigterm' | 'sigkill' = 'sigterm';
  try {
    kill(current.pid, 'TERM');

    const deadline = Date.now() + DAEMON_SHUTDOWN_GRACE_MS;
    while (Date.now() < deadline) {
      if (!l1IsAlive(current.pid, current.startTime)) break;
      await sleep(PROCESS_STOP_POLL_INTERVAL_MS);
    }

    if (l1IsAlive(current.pid, current.startTime)) {
      kill(current.pid, 'KILL');
      via = 'sigkill';
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_KILL_ESCALATED,
        `daemon_dir=${daemonDir}`,
        `pid=${current.pid}`,
      );
      const verifyDeadline = Date.now() + SIGKILL_DEAD_VERIFY_GRACE_MS;
      while (Date.now() < verifyDeadline) {
        if (!l1IsAlive(current.pid, current.startTime)) break;
        await sleep(PROCESS_STOP_POLL_INTERVAL_MS);
      }
      if (l1IsAlive(current.pid, current.startTime)) {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.STOP_PROCESS_SURVIVED_SIGKILL,
          `daemon_dir=${daemonDir}`,
          `pid=${current.pid}`,
          `grace_ms=${SIGKILL_DEAD_VERIFY_GRACE_MS}`,
        );
        return { kind: 'failed', reason: 'process survived SIGKILL' };
      }
    }
  } catch (err) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
      `daemon_dir=${daemonDir}`,
      `pid=${current.pid}`,
      `via=${via}`,
      `reason=${(err as NodeJS.ErrnoException).code || (err as Error).message}`,
    );
    return { kind: 'failed', reason: formatErr(err) };
  }

  // 信号发送后再次按 identity 定位目标，然后在真实位置 retire。
  const after = locateGeneration(ctx, daemonDir, generationId);
  if (after.kind === 'retired') {
    if (!retiredIdentityMatches(ctx, daemonDir, generationId)) {
      return {
        kind: 'failed',
        reason: `target generation ${generationId} retired directory does not match identity`,
      };
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.STOP_TARGET_RELOCATED,
      `daemon_dir=${daemonDir}`,
      `target_generation=${generationId}`,
      `current_location=retired`,
    );
  } else if (after.kind === 'foreign') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.STOP_LATE_TARGET_MISMATCH,
      `daemon_dir=${daemonDir}`,
      `target_generation=${generationId}`,
      `observed_generation=${after.observedGenerationId}`,
    );
    return {
      kind: 'failed',
      reason: `late stop after signal: slot held by different generation (${after.observedGenerationId})`,
    };
  } else if (after.kind === 'missing') {
    return {
      kind: 'failed',
      reason: `target generation ${generationId} disappeared after signal without retired evidence`,
    };
  } else {
    const disposition = retireStoppedGeneration(ctx, daemonDir, generationId, after.source);
    if (disposition.kind !== 'retired') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
        `daemon_dir=${daemonDir}`,
        `pid=${current.pid}`,
        `reason=retire_failed`,
      );
      return disposition;
    }
  }

  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
    `daemon_dir=${daemonDir}`,
    `pid=${current.pid}`,
    `via=${via}`,
    `from=${current.source}`,
  );
  return { kind: 'stopped', pid: current.pid, via };
}

/** Parent/child 路径调用：检查是否存在针对指定 generation 的 pending stop intent。 */
export function shouldAbortSpawningForStop(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
): boolean {
  return hasStopIntentForGeneration(ctx, daemonDir, generationId);
}
