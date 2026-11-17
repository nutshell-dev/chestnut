/**
 * @module L6.Watchdog.Health
 * Public, read-only health projection for a host supervisor. Private ownership
 * paths, ProcessRef decoding and audit TSV parsing stay behind their owners.
 */
import { readLastAuditEvent } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import type { WatchdogHealth } from '../foundation/supervision/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getChestnutFs } from './watchdog-context.js';
import { inspectWatchdogOwner } from './watchdog-pid.js';
import {
  inspectLatestRetiredTerminal,
  inspectTerminal,
  type WatchdogGenerationTerminal,
} from './watchdog-ownership.js';
import type { WatchdogProcessDeps } from './types.js';

const WATCHDOG_TICK_AUDIT = 'audit/tick.tsv';

function terminalHealth(
  terminal: WatchdogGenerationTerminal,
  ownerEvidence: unknown,
): WatchdogHealth {
  return {
    kind: 'terminal',
    terminal: terminal.kind,
    evidence: { owner: ownerEvidence, terminal },
  };
}

function heartbeatCoverage(cols: string[]): 'known' | 'degraded' {
  return cols.includes('coverage=known') ? 'known' : 'degraded';
}

/** Inspect health without stopping, retiring, spawning or mutating Watchdog state. */
export function inspectWatchdogHealth(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): WatchdogHealth {
  const fs = getChestnutFs(fsFactory);
  const owner = inspectWatchdogOwner(fsFactory, deps);
  if (owner.kind === 'malformed' || owner.kind === 'unknown') {
    return { kind: 'unknown', reason: 'unreadable', evidence: { owner } };
  }

  const activeTerminal = inspectTerminal(fs);
  if (activeTerminal.status === 'malformed') {
    return {
      kind: 'unknown',
      reason: 'unreadable',
      evidence: { owner, terminal: activeTerminal },
    };
  }
  if (activeTerminal.status === 'ok') return terminalHealth(activeTerminal.terminal, owner);

  if (owner.kind === 'none') {
    const retired = inspectLatestRetiredTerminal(fs);
    if (retired.status === 'malformed') {
      return { kind: 'unknown', reason: 'unreadable', evidence: { owner, retired } };
    }
    if (retired.status === 'ok') return terminalHealth(retired.terminal, owner);
    return { kind: 'unknown', reason: 'missing', evidence: { owner, retired } };
  }

  if (owner.kind === 'gone') {
    return {
      kind: 'unknown',
      reason: 'stale',
      ownerStatus: 'gone',
      evidence: { owner, terminal: activeTerminal },
    };
  }

  const heartbeat = readLastAuditEvent(fs, WATCHDOG_TICK_AUDIT, WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK);
  if (heartbeat.kind === 'io_error') {
    return { kind: 'unknown', reason: 'unreadable', evidence: { owner, heartbeat } };
  }
  if (heartbeat.kind === 'none') {
    return { kind: 'unknown', reason: 'stale', ownerStatus: 'alive', evidence: { owner, heartbeat } };
  }
  const heartbeatAtMs = Date.parse(heartbeat.event.ts);
  if (!Number.isFinite(heartbeatAtMs)) {
    return { kind: 'unknown', reason: 'unreadable', evidence: { owner, heartbeat } };
  }
  return {
    kind: 'running',
    owner: owner.decoded.value,
    heartbeatAtMs,
    coverage: heartbeatCoverage(heartbeat.event.cols),
    evidence: { owner, heartbeat },
  };
}
