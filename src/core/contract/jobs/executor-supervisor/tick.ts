/**
 * @module L4.ContractSystem.ExecutorSupervisor
 * Phase 1974 Step B: executor-supervisor tick —— 有已发布 active contract 的
 * claw，其 executor daemon 由 ContractSystem 在 motion cron tick 中确保运行。
 *
 * 策略（Phase 1974 总览验收）：
 * - 只对有已发布 active contract 的 local claw 动作；无契约不写 audit（防每 tick 噪音）。
 * - dead / absent → ensureDaemon（统一 ensureRunning 收敛，不自行 isAlive+spawn）。
 * - alive + heartbeat stale → restartDaemon；heartbeat missing/corrupt → unknown
 *   （audit、不重启、不误杀）。
 * - malformed / probe_unavailable → skipped，不 spawn（double-spawn 风险条款）。
 * - 不读 clean-stop marker（active contract 优先，用户已拍板）。
 * - motion 自身不监督（watchdog 只保留 motion daemon 监督）。
 * - 单 claw 失败隔离（allSettled + per-claw try/catch）；tick 不整体抛。
 * - 第一版不做 backoff/circuit：30s tick 自然重试。
 */
import { formatErr } from '../../../../foundation/node-utils/index.js';
import { isFileNotFound } from '../../../../foundation/fs/index.js';
import type { ClawId } from '../../../../foundation/claw-identity/index.js';
import { listActiveContracts } from '../../lightweight-query.js';
import { EXECUTOR_SUPERVISOR_AUDIT_EVENTS as EV } from './audit-events.js';
import type { ExecutorSupervisorDeps } from './types.js';

export async function runExecutorSupervisorTick(deps: ExecutorSupervisorDeps): Promise<void> {
  const now = deps.now ?? (() => Date.now());

  let clawIds: ClawId[];
  try {
    clawIds = deps.clawTopology.enumerate();
  } catch (err) {
    // 空 workspace（claws/ 未建）= 正常状态，静默返回（对齐 contract-observer）。
    if (isFileNotFound(err)) return;
    deps.audit.write(EV.SCAN_FAILED, `error=${formatErr(err)}`);
    return;
  }

  // motion daemon 监督归 watchdog；本 job 只监督 worker claw executor。
  const candidates = clawIds.filter(id => id !== deps.motionClawId);
  // 单 claw 失败不影响其他 claw；tick 不整体失败。
  await Promise.allSettled(candidates.map(clawId => superviseOne(clawId, deps, now)));
}

async function superviseOne(
  clawId: ClawId,
  deps: ExecutorSupervisorDeps,
  now: () => number,
): Promise<void> {
  if (deps.signal?.aborted) return;
  const rawClawId = clawId as string;
  try {
    let clawDir: string;
    try {
      const loc = deps.clawTopology.resolve(clawId);
      if (loc.kind !== 'local') {
        deps.audit.write(EV.SKIPPED, `claw=${rawClawId}`, `reason=non_local`);
        return;
      }
      clawDir = loc.clawDir;
    } catch (err) {
      deps.audit.write(EV.SKIPPED, `claw=${rawClawId}`, `reason=resolve_failed`, `error=${formatErr(err)}`);
      return;
    }

    // 只对有已发布 active contract 的 claw 动作（.creating 未发布不算 active）；
    // 无契约不写 audit（避免每 tick 噪音）。
    let activeCount: number;
    try {
      activeCount = listActiveContracts(deps.fsFactory(clawDir), '.').length;
    } catch (err) {
      deps.audit.write(EV.CONTRACT_SCAN_FAILED, `claw=${rawClawId}`, `error=${formatErr(err)}`);
      return;
    }
    if (activeCount === 0) return;

    let live: ReturnType<ExecutorSupervisorDeps['liveness']>;
    try {
      live = deps.liveness(rawClawId);
    } catch (err) {
      deps.audit.write(EV.LIVENESS_PROBE_FAILED, `claw=${rawClawId}`, `error=${formatErr(err)}`);
      return;
    }

    switch (live.kind) {
      case 'alive': {
        let hb: ReturnType<ExecutorSupervisorDeps['readHeartbeat']>;
        try {
          hb = deps.readHeartbeat(rawClawId);
        } catch (err) {
          // 心跳读取系统故障 → unknown 语义（不重启、不误杀）。
          deps.audit.write(EV.HEARTBEAT_UNKNOWN, `claw=${rawClawId}`, `reason=read_failed`, `error=${formatErr(err)}`);
          return;
        }
        if (hb.kind !== 'ok') {
          // 升级窗口（missing）/ 读取损坏（corrupt）→ 显式 unknown：不重启、不误判。
          deps.audit.write(EV.HEARTBEAT_UNKNOWN, `claw=${rawClawId}`, `reason=${hb.kind}`);
          return;
        }
        if (now() - hb.ts > deps.heartbeatStaleTimeoutMs) {
          deps.audit.write(
            EV.HEARTBEAT_STALE,
            `claw=${rawClawId}`,
            `heartbeat_ts=${hb.ts}`,
            `now=${now()}`,
            `stale_timeout_ms=${deps.heartbeatStaleTimeoutMs}`,
          );
          await restartOne(rawClawId, deps);
        }
        return;
      }
      case 'dead':
      case 'absent': {
        await ensureOne(rawClawId, live.kind, deps);
        return;
      }
      case 'malformed':
      case 'probe_unavailable': {
        // 证据损坏 / probe 系统故障 ≠ dead：不 spawn（double-spawn 风险条款）。
        deps.audit.write(EV.SKIPPED, `claw=${rawClawId}`, `reason=${live.kind}`);
        return;
      }
      default: {
        const _exhaustive: never = live;
        return _exhaustive;
      }
    }
  } catch (err) {
    // per-claw 兜底：任何意外 throw 不扩散到其他 claw / 不让 tick 整体失败。
    deps.audit.write(EV.SKIPPED, `claw=${rawClawId}`, `reason=internal_error`, `error=${formatErr(err)}`);
  }
}

async function ensureOne(
  rawClawId: string,
  trigger: 'dead' | 'absent',
  deps: ExecutorSupervisorDeps,
): Promise<void> {
  try {
    const outcome = await deps.ensureDaemon(rawClawId);
    deps.audit.write(
      EV.ENSURED,
      `claw=${rawClawId}`,
      `trigger=${trigger}`,
      `outcome=${outcome.kind}`,
      `pid=${outcome.pid}`,
    );
  } catch (err) {
    deps.audit.write(EV.START_FAILED, `claw=${rawClawId}`, `trigger=${trigger}`, `error=${formatErr(err)}`);
  }
}

async function restartOne(rawClawId: string, deps: ExecutorSupervisorDeps): Promise<void> {
  try {
    const { stop, ensured } = await deps.restartDaemon(rawClawId);
    // stop outcome 显式记录（failed 不吞、由装配期保证仍尝试 ensure）。
    deps.audit.write(
      EV.RESTARTED,
      `claw=${rawClawId}`,
      `stop_outcome=${stop.kind}`,
      `outcome=${ensured.kind}`,
      `pid=${ensured.pid}`,
    );
  } catch (err) {
    deps.audit.write(EV.RESTART_FAILED, `claw=${rawClawId}`, `error=${formatErr(err)}`);
  }
}
