/** Pure health-to-decision policy; persistence and restart belong to the adapter owner. */
import type { SupervisorDecision, WatchdogHealth } from './types.js';

export interface SupervisionDecisionOptions {
  nowMs: number;
  heartbeatStaleAfterMs: number;
  retryAtMs: number;
}

/** Unknown/unreadable evidence is never promoted to a crash or permission to restart. */
export function decideWatchdogSupervision(
  health: WatchdogHealth,
  options: SupervisionDecisionOptions,
): SupervisorDecision {
  const evidence = { health, policy: options };
  if (health.kind === 'running') {
    if (options.nowMs - health.heartbeatAtMs > options.heartbeatStaleAfterMs) {
      return { kind: 'restart', reason: 'heartbeat_stale', evidence };
    }
    return { kind: 'healthy', health, evidence };
  }
  if (health.kind === 'terminal') {
    if (health.terminal === 'stopped') return { kind: 'healthy', health, evidence };
    return { kind: 'restart', reason: 'terminal_unclean', evidence };
  }
  if (health.reason === 'missing'
      || (health.reason === 'stale' && health.ownerStatus === 'gone')) {
    return { kind: 'restart', reason: 'missing', evidence };
  }
  return {
    kind: 'defer',
    reason: 'capability_unavailable',
    retryAtMs: options.retryAtMs,
    evidence,
  };
}
