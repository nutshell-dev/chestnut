import type { DaemonDir, LivenessResult } from './types.js';
import { observeProcessFact } from './process-facts.js';
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
  const observation = observeProcessFact(ctx, pid.record);
  if (observation.kind === 'alive') {
    return {
      kind: 'alive', generationId: active.record.generation_id,
      pid: pid.record.pid, ...startTimeOpt, evidence: observation.evidence,
    };
  }
  if (observation.kind === 'gone') {
    return {
      kind: 'dead', generationId: active.record.generation_id,
      pid: pid.record.pid, ...startTimeOpt,
      reason: observation.reason, evidence: observation.evidence,
    };
  }
  return {
    kind: 'probe_unavailable', pid: pid.record.pid,
    error: observation.error ?? observation, evidence: observation.evidence,
  };
}

/**
 * phase 1773: LivenessResult → 展示/audit reason 的纯渲染投影（无 probe、无 IO）。
 * caller 不得用此字符串反推状态——决策必须走 discriminant，本函数只供 log/audit/view 渲染。
 */
export function describeLiveness(r: LivenessResult): string {
  switch (r.kind) {
    case 'alive':
      return `PID ${r.pid}`;
    case 'dead':
      return `PID ${r.pid} not alive`;
    case 'absent':
      return r.reason === 'missing_active'
        ? 'no active generation'
        : 'active generation without pid fact';
    case 'malformed':
      return r.file === 'generation.json'
        ? `malformed active generation: ${formatErr(r.evidence)}`
        : r.evidence === 'pid_generation_mismatch'
          ? 'active pid generation mismatch'
          : `malformed active pid: ${formatErr(r.evidence)}`;
    case 'probe_unavailable':
      return `probe unavailable: ${formatErr(r.error)}`;
  }
}
