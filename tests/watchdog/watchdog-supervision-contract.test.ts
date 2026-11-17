/** Phase 2184: stable host-supervisor health and conservative decision contract. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { decodeProcessRef, type ProcessRef } from '../../src/foundation/process-exec/index.js';
import {
  decideWatchdogSupervision,
  type SupervisorReceipt,
  type WatchdogHealth,
} from '../../src/foundation/supervision/index.js';
import { inspectWatchdogHealth } from '../../src/watchdog/index.js';
import {
  _resetWatchdogContextForTest,
  setAuditWriter,
} from '../../src/watchdog/watchdog-context.js';
import {
  commitOwnership,
  newWatchdogAttempt,
  prepareCandidate,
  recordGenerationTerminal,
  retireOwnership,
  WATCHDOG_ACTIVE_DIR,
  type WatchdogOwnerRecord,
} from '../../src/watchdog/watchdog-ownership.js';
import type { WatchdogProcessDeps } from '../../src/watchdog/types.js';

const originalRoot = process.env.CHESTNUT_ROOT;
let tmpDir: string;
let chestnutDir: string;
const fsFactory = (baseDir: string): NodeFileSystem => new NodeFileSystem({ baseDir });

function seedActive(record: WatchdogOwnerRecord = newWatchdogAttempt(424242)): WatchdogOwnerRecord {
  const chestnutFs = fsFactory(chestnutDir);
  prepareCandidate(chestnutFs, record);
  commitOwnership(chestnutFs, record);
  return record;
}

function aliveDeps(record: WatchdogOwnerRecord): WatchdogProcessDeps {
  const decoded = decodeProcessRef(record.process_ref);
  if (decoded.kind !== 'decoded') throw new Error('fixture ProcessRef did not decode');
  return {
    decodeProcessRef: () => decoded,
    inspectProcessRef: () => ({ kind: 'alive', evidence: [] }),
  };
}

function writeTick(lines: string[]): void {
  const auditDir = path.join(chestnutDir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(auditDir, 'tick.tsv'), `${lines.join('\n')}\n`);
}

beforeEach(() => {
  _resetWatchdogContextForTest();
  setAuditWriter(null);
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-supervision-${randomUUID()}`);
  chestnutDir = path.join(tmpDir, '.chestnut');
  fs.mkdirSync(chestnutDir, { recursive: true });
  process.env.CHESTNUT_ROOT = tmpDir;
});

afterEach(() => {
  setAuditWriter(null);
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Watchdog health public capability', () => {
  it('projects a live owner and latest watchdog_check without exposing layout', () => {
    const record = seedActive();
    writeTick([
      '2026-11-17T00:00:00.000Z\twatchdog_check\tcoverage=unknown',
      '2026-11-17T00:00:01.000Z\twatchdog_claw_scan\talive=1',
      '2026-11-17T00:00:02.000Z\twatchdog_check\tcoverage=known',
    ]);

    const health = inspectWatchdogHealth(fsFactory, aliveDeps(record));

    expect(health).toMatchObject({
      kind: 'running',
      heartbeatAtMs: Date.parse('2026-11-17T00:00:02.000Z'),
      coverage: 'known',
    });
    if (health.kind === 'running') {
      expect(health.owner).toBe(decodeProcessRef(record.process_ref).kind === 'decoded'
        ? (decodeProcessRef(record.process_ref) as { value: ProcessRef }).value
        : undefined);
    }
  });

  it('finds the latest check even when later scan events exceed the tail window', () => {
    const record = seedActive();
    writeTick([
      '2026-11-17T00:00:03.000Z\twatchdog_check\tcoverage=known',
      ...Array.from({ length: 100 }, (_, i) =>
        `2026-11-17T00:01:${String(i % 60).padStart(2, '0')}.000Z\twatchdog_claw_scan\tpayload=${'x'.repeat(100)}`),
    ]);

    expect(inspectWatchdogHealth(fsFactory, aliveDeps(record))).toMatchObject({
      kind: 'running', heartbeatAtMs: Date.parse('2026-11-17T00:00:03.000Z'),
    });
  });

  it('reports missing instead of inventing a terminal', () => {
    expect(inspectWatchdogHealth(fsFactory)).toMatchObject({ kind: 'unknown', reason: 'missing' });
  });

  it('keeps malformed active evidence unreadable', () => {
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), '{bad');
    expect(inspectWatchdogHealth(fsFactory)).toMatchObject({ kind: 'unknown', reason: 'unreadable' });
  });

  it('keeps a verified-gone owner without terminal stale, not crashed', () => {
    const record = seedActive();
    const decoded = decodeProcessRef(record.process_ref);
    if (decoded.kind !== 'decoded') throw new Error('fixture ProcessRef did not decode');
    const health = inspectWatchdogHealth(fsFactory, {
      decodeProcessRef: () => decoded,
      inspectProcessRef: () => ({ kind: 'gone', reason: 'absent', evidence: [] }),
    });
    expect(health).toMatchObject({ kind: 'unknown', reason: 'stale', ownerStatus: 'gone' });
    expect(decideWatchdogSupervision(health, {
      nowMs: 10_000, heartbeatStaleAfterMs: 1_000, retryAtMs: 20_000,
    })).toMatchObject({ kind: 'restart', reason: 'missing' });
  });


  it('reads a graceful stopped terminal after active retires', () => {
    const record = seedActive();
    const identity = { attemptId: record.attempt_id, ownerToken: record.owner_token, pid: record.pid };
    expect(recordGenerationTerminal(fsFactory(chestnutDir), identity, {
      kind: 'stopped', signal: 'SIGTERM', recorded_at: '2026-11-17T00:00:00.000Z',
    }).kind).toBe('recorded');
    expect(retireOwnership(fsFactory(chestnutDir), identity, 'shutdown').kind).toBe('retired');

    expect(inspectWatchdogHealth(fsFactory)).toMatchObject({ kind: 'terminal', terminal: 'stopped' });
  });

  it('does not treat a live owner without a heartbeat as dead', () => {
    const record = seedActive();
    expect(inspectWatchdogHealth(fsFactory, aliveDeps(record))).toMatchObject({
      kind: 'unknown', reason: 'stale', ownerStatus: 'alive',
    });
  });
});

describe('host-supervisor decision contract', () => {
  const owner = 'opaque-process-ref' as ProcessRef;
  const options = { nowMs: 10_000, heartbeatStaleAfterMs: 1_000, retryAtMs: 20_000 };
  const running: WatchdogHealth = {
    kind: 'running', owner, heartbeatAtMs: 9_500, coverage: 'known', evidence: { raw: true },
  };

  it('keeps fresh and gracefully stopped generations healthy', () => {
    expect(decideWatchdogSupervision(running, options)).toMatchObject({ kind: 'healthy' });
    expect(decideWatchdogSupervision({
      kind: 'terminal', terminal: 'stopped', evidence: { signal: 'SIGTERM' },
    }, options)).toMatchObject({ kind: 'healthy' });
  });

  it.each([
    ['heartbeat_stale', { ...running, heartbeatAtMs: 0 } as WatchdogHealth],
    ['terminal_unclean', { kind: 'terminal', terminal: 'crashed', evidence: {} } as WatchdogHealth],
    ['terminal_unclean', { kind: 'terminal', terminal: 'unclean', evidence: {} } as WatchdogHealth],
    ['missing', { kind: 'unknown', reason: 'missing', evidence: {} } as WatchdogHealth],
    ['missing', { kind: 'unknown', reason: 'stale', ownerStatus: 'gone', evidence: { sigkill: true } } as WatchdogHealth],
  ])('restart %s retains raw evidence', (reason, health) => {
    const decision = decideWatchdogSupervision(health, options);
    expect(decision).toMatchObject({ kind: 'restart', reason });
    expect(decision.evidence).toMatchObject({ health });
  });

  it.each([
    ['unreadable', { kind: 'unknown', reason: 'unreadable', evidence: { error: 'EACCES' } } as WatchdogHealth],
    ['stale', { kind: 'unknown', reason: 'stale', ownerStatus: 'alive', evidence: { heartbeat: 'missing' } } as WatchdogHealth],
  ])('defers uncertain %s health without fabricating a crash', (reason, health) => {
    const decision = decideWatchdogSupervision(health, options);
    expect(decision).toMatchObject({
      kind: 'defer', reason: 'capability_unavailable', retryAtMs: options.retryAtMs,
    });
    expect(decision.evidence).toMatchObject({ health: { reason } });
  });

  it('receipt schema carries request, attempt, owner and raw failure evidence', () => {
    const evidence = { code: 'EACCES', stderr: 'denied' };
    const receipt: SupervisorReceipt = {
      request: { reason: 'heartbeat_stale', correlationId: 'correlation-1' },
      attempt: 'attempt-1',
      owner: { ownerId: 'host-1', mechanism: 'fixture' },
      result: 'failed',
      evidence,
    };
    expect(receipt).toMatchObject({
      request: { correlationId: 'correlation-1' }, attempt: 'attempt-1', result: 'failed', evidence,
    });
  });
});
