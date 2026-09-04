import type { DaemonDir, LivenessResult } from './types.js';
import { isAlive as defaultL1IsAlive, makeProcessStartTime } from '../process-exec/index.js';
import { formatErr } from '../node-utils/index.js';
import type { ProcessManagerContext } from './types.js';
import { inspectActive, inspectActivePid } from './generation.js';

/**
 * Liveness typed owner（phase 1773, Phase 1772 冻结设计）。
 *
 * Phase 1204 Step E：active/pid.json 是唯一 SoT；legacy status/pid 已删除。
 * 对外穷举 discriminant：probe 异常（EPERM/未知错误）不再保守伪装 alive，
 * 交付 probe_unavailable 由 caller 显式决策（risk：误判 dead 会 double-spawn）。
 */
export function liveness(ctx: ProcessManagerContext, daemonDir: DaemonDir): LivenessResult {
  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'malformed') {
    return { kind: 'malformed', file: 'generation.json', evidence: active.cause };
  }
  if (active.status === 'none') return { kind: 'absent', reason: 'missing_active' };

  const pid = inspectActivePid(ctx, daemonDir);
  if (pid.status === 'malformed') {
    return { kind: 'malformed', file: 'pid.json', evidence: pid.cause };
  }
  if (pid.status === 'none') return { kind: 'absent', reason: 'missing_pid' };

  if (pid.record.generation_id !== active.record.generation_id) {
    // 磁盘证据完整性损坏：pid 事实不属于 active generation（fail-closed，不猜）
    return { kind: 'malformed', file: 'pid.json', evidence: 'pid_generation_mismatch' };
  }

  const startTime = pid.record.start_time;
  const startTimeOpt = startTime !== undefined ? { startTime } : {};
  try {
    const alive = (ctx.l1IsAlive ?? defaultL1IsAlive)(
      pid.record.pid,
      startTime !== undefined ? makeProcessStartTime(startTime) : undefined,
    );
    return alive
      ? { kind: 'alive', pid: pid.record.pid, ...startTimeOpt }
      : { kind: 'dead', pid: pid.record.pid, ...startTimeOpt };
  } catch (err) {
    // ESRCH = pid 已消失（死亡终局）；其他 probe 异常 = 系统故障，不压平
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return { kind: 'dead', pid: pid.record.pid, ...startTimeOpt };
    }
    return { kind: 'probe_unavailable', pid: pid.record.pid, error: err };
  }
}

/**
 * @deprecated phase 1773 Step A 过渡适配器——旧 `{alive, reason:string}` 表面
 * （含 EPERM/未知 probe 错误保守映射 alive:true 的 drift 行为）。Step B 删。
 */
export function getAliveStatus(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): { alive: boolean; reason: string; pid?: number } {
  const r = liveness(ctx, daemonDir);
  switch (r.kind) {
    case 'alive':
      return { alive: true, reason: `PID ${r.pid}`, pid: r.pid };
    case 'dead':
      return { alive: false, reason: `PID ${r.pid} not alive`, pid: r.pid };
    case 'absent':
      return {
        alive: false,
        reason: r.reason === 'missing_active'
          ? 'no active generation'
          : 'active generation without pid fact',
      };
    case 'malformed':
      if (r.file === 'generation.json') {
        return { alive: false, reason: `malformed active generation: ${formatErr(r.evidence)}` };
      }
      if (r.evidence === 'pid_generation_mismatch') {
        return { alive: false, reason: 'active pid generation mismatch' };
      }
      return { alive: false, reason: `malformed active pid: ${formatErr(r.evidence)}` };
    case 'probe_unavailable':
      // 过渡期内复刻旧 drift 行为（保守 alive:true）；Step B caller 迁移后此适配器删除
      return (r.error as NodeJS.ErrnoException).code === 'EPERM'
        ? { alive: true, reason: 'isAlive EPERM (process exists, cannot probe)', pid: r.pid }
        : { alive: true, reason: `isAlive probe failed: ${formatErr(r.error)}`, pid: r.pid };
  }
}
