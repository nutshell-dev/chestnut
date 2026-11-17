/**
 * @module L1.Supervision.Types
 * Stable host-supervisor protocol. OS service managers implement this boundary;
 * Watchdog owns health evidence and CLI only requests supervision.
 */
import type { ProcessRef } from '../process-exec/index.js';

export type SupervisionAvailability =
  | { kind: 'available'; ownerId: string; mechanism: string }
  | {
      kind: 'unavailable';
      reason: 'not_installed' | 'permission_denied' | 'unsupported';
      evidence: unknown;
    };

export type WatchdogHealth =
  | {
      kind: 'running';
      owner: ProcessRef;
      heartbeatAtMs: number;
      coverage: 'known' | 'degraded';
      evidence: unknown;
    }
  | {
      kind: 'terminal';
      terminal: 'stopped' | 'crashed' | 'unclean';
      evidence: unknown;
    }
  | {
      kind: 'unknown';
      reason: 'missing' | 'unreadable' | 'stale';
      /** Verified owner fact, when available; uncertainty remains in evidence. */
      ownerStatus?: 'alive' | 'gone';
      evidence: unknown;
    };

export interface SupervisorRequest {
  reason: string;
  correlationId: string;
}

export interface SupervisorOwner {
  ownerId: string;
  mechanism: string;
}

export type SupervisorResult =
  | 'started'
  | 'already_running'
  | 'deferred'
  | 'unavailable'
  | 'failed';

/** Every outcome retains the request and raw adapter evidence; non-success is not started. */
export interface SupervisorReceipt {
  request: SupervisorRequest;
  attempt: string | null;
  owner: SupervisorOwner | null;
  result: SupervisorResult;
  evidence: unknown;
  retryAtMs?: number;
}

export interface HostSupervisor {
  inspectAvailability(): Promise<SupervisionAvailability>;
  ensureWatchdog(request: SupervisorRequest): Promise<SupervisorReceipt>;
}

export type SupervisorDecision =
  | { kind: 'healthy'; health: WatchdogHealth; evidence: unknown }
  | {
      kind: 'restart';
      reason: 'heartbeat_stale' | 'terminal_unclean' | 'missing';
      evidence: unknown;
    }
  | {
      kind: 'defer';
      reason: 'startup_conflict' | 'capability_unavailable';
      retryAtMs: number;
      evidence: unknown;
    };
