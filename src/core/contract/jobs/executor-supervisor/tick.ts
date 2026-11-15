/**
 * @module L4.ContractSystem.ExecutorSupervisor
 * Phase 1974 Step B / Phase 2155 Step B4: executor-supervisor tick。
 *
 * - 只对有已发布 active contract 的 local claw 动作；motion 自身归 watchdog。
 * - dead / absent → ensureDaemon；alive + heartbeat stale → restartDaemon。
 * - malformed / probe_unavailable / heartbeat unknown 不推进持久 recovery。
 * - 恢复动作失败写 per-claw backoff/circuit；窗口内不 probe、不重复动作。
 * - 动作成功先落 action_succeeded 屏障再 clear；clear 失败下一 tick 只复核清理。
 * - 单 claw 失败隔离（allSettled + per-claw try/catch）；tick 不整体抛。
 */
import { formatErr } from '../../../../foundation/node-utils/index.js';
import { isFileNotFound } from '../../../../foundation/fs/index.js';
import type { ClawId } from '../../../../foundation/claw-identity/index.js';
import { listActiveContracts } from '../../lightweight-query.js';
import { EXECUTOR_SUPERVISOR_AUDIT_EVENTS as EV } from './audit-events.js';
import {
  reduceSupervisorFailure,
  type SupervisorRecoveryState,
  type SupervisorRecoveryStore,
} from './recovery-state.js';
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

  const candidates = clawIds.filter(id => id !== deps.motionClawId);
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

    let clawFs: ReturnType<ExecutorSupervisorDeps['fsFactory']>;
    try {
      clawFs = deps.fsFactory(clawDir);
      if (listActiveContracts(clawFs, '.').length === 0) return;
    } catch (err) {
      deps.audit.write(EV.CONTRACT_SCAN_FAILED, `claw=${rawClawId}`, `error=${formatErr(err)}`);
      return;
    }

    let recovery: SupervisorRecoveryStore;
    let loaded: Awaited<ReturnType<SupervisorRecoveryStore['load']>>;
    try {
      recovery = deps.recoveryStateFactory(clawFs, rawClawId);
      loaded = await recovery.load();
    } catch (err) {
      deps.audit.write(
        EV.RECOVERY_STATE_UNREADABLE,
        `claw=${rawClawId}`,
        `error=${formatErr(err)}`,
      );
      return;
    }
    if (loaded.kind === 'unreadable') {
      deps.audit.write(
        EV.RECOVERY_STATE_UNREADABLE,
        `claw=${rawClawId}`,
        `error=${loaded.reason}`,
      );
      return;
    }
    const previous = loaded.kind === 'scheduled' ? loaded.state : undefined;

    // 成功事实已提交但上次 clear 失败：不得重放旧 intent。
    if (previous?.status === 'action_succeeded') {
      await clearRecovery(rawClawId, previous, recovery, deps, 'pending_clear', true);
      return;
    }
    if (previous && now() < previous.next_attempt_at) {
      deps.audit.write(
        EV.RECOVERY_DEFERRED,
        `claw=${rawClawId}`,
        `attempt=${previous.attempt}`,
        `next_attempt_at=${previous.next_attempt_at}`,
        `circuit=${previous.circuit}`,
      );
      return;
    }

    let live: ReturnType<ExecutorSupervisorDeps['liveness']>;
    try {
      live = deps.liveness(rawClawId);
    } catch (err) {
      deps.audit.write(EV.LIVENESS_PROBE_FAILED, `claw=${rawClawId}`, `error=${formatErr(err)}`);
      return;
    }

    switch (live.kind) {
      case 'alive': {
        const observedAt = now();
        const evidenceCols = (hb?: ReturnType<ExecutorSupervisorDeps['readHeartbeat']>): string[] => [
          `live_generation=${live.generationId ?? 'unknown'}`,
          `live_pid=${live.pid}`,
          `live_start_time=${live.startTime ?? 'unknown'}`,
          `heartbeat_generation=${hb?.kind === 'ok' ? hb.generationId : 'unknown'}`,
          `heartbeat_pid=${hb?.kind === 'ok' ? hb.pid : 'unknown'}`,
          `heartbeat_start_time=${hb?.kind === 'ok' ? hb.startTime : 'unknown'}`,
          `heartbeat_ts=${hb?.kind === 'ok' ? hb.ts : 'unknown'}`,
          `observed_at=${observedAt}`,
        ];
        const auditUnknown = (
          reason: string,
          hb?: ReturnType<ExecutorSupervisorDeps['readHeartbeat']>,
          error?: unknown,
        ): void => {
          deps.audit.write(
            EV.HEARTBEAT_UNKNOWN,
            `claw=${rawClawId}`,
            `reason=${reason}`,
            ...evidenceCols(hb),
            ...(error !== undefined ? [`error=${formatErr(error)}`] : []),
          );
        };

        let hb: ReturnType<ExecutorSupervisorDeps['readHeartbeat']>;
        try {
          hb = deps.readHeartbeat(rawClawId);
        } catch (err) {
          auditUnknown('read_failed', undefined, err);
          return;
        }
        if (hb.kind !== 'ok') {
          auditUnknown(hb.kind, hb, hb.kind === 'corrupt' ? hb.reason : undefined);
          return;
        }
        if (
          live.generationId === undefined
          || live.startTime === undefined
          || hb.generationId !== live.generationId
          || hb.pid !== live.pid
          || hb.startTime !== live.startTime
        ) {
          auditUnknown('identity_mismatch_or_missing', hb);
          return;
        }
        if (hb.ts > observedAt) {
          auditUnknown('future_timestamp', hb);
          return;
        }
        if (observedAt - hb.ts > deps.heartbeatStaleTimeoutMs) {
          deps.audit.write(
            EV.HEARTBEAT_STALE,
            `claw=${rawClawId}`,
            `now=${observedAt}`,
            `stale_timeout_ms=${deps.heartbeatStaleTimeoutMs}`,
            ...evidenceCols(hb),
          );
          await restartOne(rawClawId, deps, previous, recovery, now);
          return;
        }

        // open circuit 不是永久放弃：已观察到健康进程，收敛旧 intent。
        if (previous) {
          await clearRecovery(rawClawId, previous, recovery, deps, 'observed_healthy', false);
        }
        return;
      }
      case 'dead':
      case 'absent': {
        // open + 到期 + liveness 可用 = capped 半开探测；unknown 不会走到这里。
        await ensureOne(rawClawId, live.kind, deps, previous, recovery, now);
        return;
      }
      case 'malformed':
      case 'probe_unavailable': {
        deps.audit.write(EV.SKIPPED, `claw=${rawClawId}`, `reason=${live.kind}`);
        return;
      }
      default: {
        const _exhaustive: never = live;
        return _exhaustive;
      }
    }
  } catch (err) {
    deps.audit.write(EV.SKIPPED, `claw=${rawClawId}`, `reason=internal_error`, `error=${formatErr(err)}`);
  }
}

async function ensureOne(
  rawClawId: string,
  trigger: 'dead' | 'absent',
  deps: ExecutorSupervisorDeps,
  previous: SupervisorRecoveryState | undefined,
  recovery: SupervisorRecoveryStore,
  now: () => number,
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
    if (previous) {
      const succeeded: SupervisorRecoveryState = { ...previous, status: 'action_succeeded' };
      if (await saveRecovery(rawClawId, succeeded, recovery, deps, true)) {
        await clearRecovery(rawClawId, succeeded, recovery, deps, 'action_succeeded', true);
      }
    }
  } catch (err) {
    deps.audit.write(EV.START_FAILED, `claw=${rawClawId}`, `trigger=${trigger}`, `error=${formatErr(err)}`);
    await recordFailure(rawClawId, 'ensure', err, previous, recovery, deps, now);
  }
}

async function restartOne(
  rawClawId: string,
  deps: ExecutorSupervisorDeps,
  previous: SupervisorRecoveryState | undefined,
  recovery: SupervisorRecoveryStore,
  now: () => number,
): Promise<void> {
  try {
    const { stop, ensured } = await deps.restartDaemon(rawClawId);
    deps.audit.write(
      EV.RESTARTED,
      `claw=${rawClawId}`,
      `stop_outcome=${stop.kind}`,
      `outcome=${ensured.kind}`,
      `pid=${ensured.pid}`,
    );
    if (previous) {
      const succeeded: SupervisorRecoveryState = { ...previous, status: 'action_succeeded' };
      if (await saveRecovery(rawClawId, succeeded, recovery, deps, true)) {
        await clearRecovery(rawClawId, succeeded, recovery, deps, 'action_succeeded', true);
      }
    }
  } catch (err) {
    deps.audit.write(EV.RESTART_FAILED, `claw=${rawClawId}`, `error=${formatErr(err)}`);
    await recordFailure(rawClawId, 'restart', err, previous, recovery, deps, now);
  }
}

async function recordFailure(
  rawClawId: string,
  intent: SupervisorRecoveryState['intent'],
  error: unknown,
  previous: SupervisorRecoveryState | undefined,
  recovery: SupervisorRecoveryStore,
  deps: ExecutorSupervisorDeps,
  now: () => number,
): Promise<void> {
  const next = reduceSupervisorFailure(previous, {
    clawId: rawClawId,
    intent,
    now: now(),
    error: formatErr(error),
  });
  if (!(await saveRecovery(rawClawId, next, recovery, deps, false))) return;
  deps.audit.write(
    EV.RECOVERY_SCHEDULED,
    `claw=${rawClawId}`,
    `attempt=${next.attempt}`,
    `next_attempt_at=${next.next_attempt_at}`,
    `circuit=${next.circuit}`,
  );
}

/** false 仅表示 rename 前失败；committed_* 明确按已写入继续 transition。 */
async function saveRecovery(
  rawClawId: string,
  state: SupervisorRecoveryState,
  recovery: SupervisorRecoveryStore,
  deps: ExecutorSupervisorDeps,
  actionSucceeded: boolean,
): Promise<boolean> {
  try {
    const result = await recovery.save(state);
    if (result.kind !== 'durable') {
      deps.audit.write(
        EV.RECOVERY_STATE_WRITE_DEGRADED,
        `claw=${rawClawId}`,
        `durability=${result.kind}`,
        `action_succeeded=${actionSucceeded}`,
        `error=${formatErr(result.error)}`,
      );
    }
    return true;
  } catch (err) {
    deps.audit.write(
      EV.RECOVERY_STATE_WRITE_FAILED,
      `claw=${rawClawId}`,
      `action_succeeded=${actionSucceeded}`,
      `error=${formatErr(err)}`,
    );
    return false;
  }
}

async function clearRecovery(
  rawClawId: string,
  state: SupervisorRecoveryState,
  recovery: SupervisorRecoveryStore,
  deps: ExecutorSupervisorDeps,
  reason: 'action_succeeded' | 'pending_clear' | 'observed_healthy',
  actionSucceeded: boolean,
): Promise<void> {
  try {
    await recovery.clear();
    deps.audit.write(
      EV.RECOVERY_CLEARED,
      `claw=${rawClawId}`,
      `reason=${reason}`,
      `intent=${state.intent}`,
      `attempt=${state.attempt}`,
    );
  } catch (err) {
    // ENSURED/RESTARTED 已记录动作成功；此处独立保留清理失败事实。
    deps.audit.write(
      EV.RECOVERY_CLEAR_FAILED,
      `claw=${rawClawId}`,
      `action_succeeded=${actionSucceeded}`,
      `intent=${state.intent}`,
      `attempt=${state.attempt}`,
      `error=${formatErr(err)}`,
    );
  }
}
