import type { DaemonDir, ReadinessResult } from './types.js';
import { formatErr } from '../node-utils/index.js';
import { isAlive as defaultL1IsAlive, makeProcessStartTime } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import type { ProcessManagerContext } from './types.js';
import { inspectActive, inspectActiveReady } from './generation.js';

/**
 * Readiness typed owner（phase 1771, Phase 1770 冻结设计）。
 *
 * ready 事实只从 generation active/ready.json 读取（Phase 1204 Step E）；对外区分
 * not-ready 与 malformed/read_failure/probe_unavailable 系统故障，原始 error
 * evidence 不丢。系统故障不得压平为 not_ready（risk 条款）。
 */
export function readiness(ctx: ProcessManagerContext, daemonDir: DaemonDir): ReadinessResult {
  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=active`,
      `ctx=readiness`,
      `reason=${ctx.audit.message(formatErr(active.cause))}`,
    );
    // phase 1771: 读失败（权限/IO）与内容畸形分型交付，原始 error 保留
    return active.source === 'read'
      ? { kind: 'read_failure', file: 'generation.json', error: active.cause }
      : { kind: 'malformed', file: 'generation.json', error: active.cause };
  }
  if (active.status === 'none') return { kind: 'not_ready', reason: 'missing_active' };

  const ready = inspectActiveReady(ctx, daemonDir);
  if (ready.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=active`,
      `ctx=readiness`,
      `file=ready`,
      `reason=${ctx.audit.message(formatErr(ready.cause))}`,
    );
    return ready.source === 'read'
      ? { kind: 'read_failure', file: 'ready.json', error: ready.cause }
      : { kind: 'malformed', file: 'ready.json', error: ready.cause };
  }
  if (ready.status === 'none') return { kind: 'not_ready', reason: 'missing_ready' };

  if (ready.record.generation_id !== active.record.generation_id) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
      `daemon_dir=${daemonDir}`,
      `ready_generation=${ready.record.generation_id}`,
      `active_generation=${active.record.generation_id}`,
    );
    return { kind: 'not_ready', reason: 'stale_generation' };
  }

  try {
    const alive = (ctx.l1IsAlive ?? defaultL1IsAlive)(
      ready.record.pid,
      ready.record.start_time !== undefined
        ? makeProcessStartTime(ready.record.start_time)
        : undefined,
    );
    return alive
      ? { kind: 'ready', generationId: active.record.generation_id, pid: ready.record.pid }
      : { kind: 'not_ready', reason: 'process_not_alive' };
  } catch (err) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW,
      `daemon_dir=${daemonDir}`,
      `ready_pid=${ready.record.pid}`,
      `reason=${formatErr(err)}`,
    );
    return { kind: 'probe_unavailable', error: err };
  }
}

/**
 * Convenience fail-closed 语义（Phase 1770 设计保留）：仅实现
 * `readiness(...).kind === 'ready'`，不得承载其它状态判断。
 */
export function isReady(ctx: ProcessManagerContext, daemonDir: DaemonDir): boolean {
  return readiness(ctx, daemonDir).kind === 'ready';
}
