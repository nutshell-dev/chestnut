/**
 * Phase 2135 Step B：motion viewport 的 turn 恢复。
 *
 * 只读取 daemon-owned turn-state 与 heartbeat 两个固定文件；身份、PID、时钟和
 * 新鲜度全部匹配才恢复 active，其余情况一律 fail-closed 到 idle。
 */
import type { AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { readDaemonHeartbeat, readDaemonTurnState } from '../daemon/index.js';
import type { TurnTracker } from './chat-viewport-types.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

export const MOTION_HEARTBEAT_FRESHNESS_MS = 180_000;
export const MOTION_TURN_STATE_FRESHNESS_MS = 300_000;

interface MotionTurnRecoveryDeps {
  fs: FileSystem;
  clawId: string;
  turnTracker: Pick<TurnTracker, 'begin' | 'forceReset'>;
  audit?: Pick<AuditLog, 'write'>;
  now?: () => number;
  heartbeatFreshnessMs?: number;
  turnStateFreshnessMs?: number;
}

function isFresh(ts: number, now: number, thresholdMs: number): boolean {
  return ts <= now && now - ts <= thresholdMs;
}

function auditCorrupt(deps: MotionTurnRecoveryDeps, source: 'turn_state' | 'heartbeat', reason: string): void {
  try {
    deps.audit?.write(
      VIEWPORT_AUDIT_EVENTS.MOTION_TURN_RECOVERY_FAILED,
      `source=${source}`,
      `reason=${reason}`,
    );
  } catch (error) {
    // 恢复已 fail-closed；audit 自身失败不得阻断 viewport，stderr 保留二次失败证据。
    console.error(`[viewport] motion turn recovery audit failed: ${String(error)}`);
  }
}

export function recoverMotionTurnState(deps: MotionTurnRecoveryDeps): void {
  const now = (deps.now ?? Date.now)();
  const turn = readDaemonTurnState(deps.fs);
  const heartbeat = readDaemonHeartbeat(deps.fs);
  if (turn.kind === 'corrupt') auditCorrupt(deps, 'turn_state', turn.error);
  if (heartbeat.kind === 'corrupt' || heartbeat.kind === 'legacy') {
    auditCorrupt(deps, 'heartbeat', heartbeat.error);
  }

  const recoverActive = turn.kind === 'ok'
    && turn.fact.phase === 'active'
    && turn.fact.clawId === deps.clawId
    && heartbeat.kind === 'ok'
    && Number.isSafeInteger(heartbeat.fact.pid)
    && heartbeat.fact.pid > 0
    && turn.fact.daemonPid === heartbeat.fact.pid
    && isFresh(
      heartbeat.fact.ts,
      now,
      deps.heartbeatFreshnessMs ?? MOTION_HEARTBEAT_FRESHNESS_MS,
    )
    && isFresh(
      turn.fact.updatedAtMs,
      now,
      deps.turnStateFreshnessMs ?? MOTION_TURN_STATE_FRESHNESS_MS,
    )
    && turn.fact.startedAtMs <= now;

  if (recoverActive) deps.turnTracker.begin();
  else deps.turnTracker.forceReset();
}
