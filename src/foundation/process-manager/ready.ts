import type { DaemonDir } from './types.js';
import { formatErr } from '../node-utils/index.js';
import { isAlive as defaultL1IsAlive, makeProcessStartTime } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import type { ProcessManagerContext } from './types.js';
import { inspectActive, inspectActiveReady } from './generation.js';

/**
 * Check whether the daemon has marked itself ready and is still the same process.
 *
 * Phase 1204 Step E: ready 事实只从 generation active/ready.json 读取；legacy
 * status/ready 文件已随 lock/pid 路径一起删除。
 */
export function isReady(ctx: ProcessManagerContext, daemonDir: DaemonDir): boolean {
  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=active`,
      `ctx=isReady`,
      `reason=${ctx.audit.message(formatErr(active.cause))}`,
    );
    return false;
  }
  if (active.status === 'none') return false;

  const ready = inspectActiveReady(ctx, daemonDir);
  if (ready.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=active`,
      `ctx=isReady`,
      `file=ready`,
      `reason=${ctx.audit.message(formatErr(ready.cause))}`,
    );
    return false;
  }
  if (ready.status === 'none') return false;

  if (ready.record.generation_id !== active.record.generation_id) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
      `daemon_dir=${daemonDir}`,
      `ready_generation=${ready.record.generation_id}`,
      `active_generation=${active.record.generation_id}`,
    );
    return false;
  }

  try {
    return (ctx.l1IsAlive ?? defaultL1IsAlive)(
      ready.record.pid,
      ready.record.start_time !== undefined
        ? makeProcessStartTime(ready.record.start_time)
        : undefined,
    );
  } catch (err) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW,
      `daemon_dir=${daemonDir}`,
      `ready_pid=${ready.record.pid}`,
      `reason=${formatErr(err)}`,
    );
    return false;
  }
}
