/**
 * Phase 1269 Step E — L1 legacy single-process compatibility path.
 *
 * Real-process integration tests (no mocks): ownership probe and the bounded
 * TERM→grace→KILL→confirm state machine for pre-phase-1269 PID-only tasks.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import {
  probeLegacyProcess,
  terminateLegacyProcess,
} from '../../../src/foundation/process-exec/legacy-process.js';
import { getProcessStartTime } from '../../../src/foundation/process-exec/process-starttime.js';
import { isAlive } from '../../../src/foundation/process-exec/process-control.js';

/** PID far above any realistic live PID on the test host. */
const DEAD_PID = 99_999_999;

const children: ChildProcess[] = [];

function spawnSleep(seconds: string): ChildProcess {
  const child = spawn('sleep', [seconds], { stdio: 'ignore' });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* silent: already dead */ }
  }
});

describe('phase 1269 Step E: legacy single-process probe', () => {
  it('live process with matching start time probes alive', () => {
    const child = spawnSleep('30');
    const startTime = getProcessStartTime(child.pid!);
    expect(startTime).toBeDefined();
    expect(probeLegacyProcess(child.pid!, startTime)).toEqual({ kind: 'alive' });
  });

  it('start time mismatch probes gone (PID reused) — never alive', () => {
    const child = spawnSleep('30');
    expect(probeLegacyProcess(child.pid!, 'Mon Jan 01 00:00:00 1999')).toEqual({ kind: 'gone' });
  });

  it('dead pid probes gone', () => {
    expect(probeLegacyProcess(DEAD_PID)).toEqual({ kind: 'gone' });
  });

  it('without a start time, liveness alone decides', () => {
    const child = spawnSleep('30');
    expect(probeLegacyProcess(child.pid!)).toEqual({ kind: 'alive' });
  });
});

describe('phase 1269 Step E: legacy single-process termination', () => {
  it('cooperative process dies on SIGTERM without escalation', async () => {
    const child = spawnSleep('30');
    const pid = child.pid!;
    const startTime = getProcessStartTime(pid);

    const outcome = await terminateLegacyProcess(pid, startTime);

    expect(outcome.status).toBe('gone');
    expect(outcome.termSent).toBe(true);
    expect(outcome.killSent).toBe(false);
    expect(isAlive(pid)).toBe(false);
  });

  it('TERM-ignoring process escalates to SIGKILL within the bounded budget', async () => {
    const child = spawn('sh', ['-c', 'trap "" TERM; echo READY; while :; do sleep 0.2; done'], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child);
    const pid = child.pid!;
    // Wait until the trap is installed, otherwise the TERM can land before
    // `trap "" TERM` runs and the test never exercises the KILL escalation.
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('exit', () => reject(new Error('TERM-ignoring process exited before READY')));
    });

    const startedAt = Date.now();
    const outcome = await terminateLegacyProcess(pid, undefined, { graceMs: 200, confirmMs: 2000 });

    expect(outcome.status).toBe('gone');
    expect(outcome.termSent).toBe(true);
    expect(outcome.killSent).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(isAlive(pid)).toBe(false);
  });

  it('dead pid reports gone without sending any signal', async () => {
    const outcome = await terminateLegacyProcess(DEAD_PID);

    expect(outcome.status).toBe('gone');
    expect(outcome.termSent).toBe(false);
    expect(outcome.killSent).toBe(false);
  });

  it('reused PID (start time mismatch) is never signalled', async () => {
    const child = spawnSleep('30');
    const pid = child.pid!;

    const outcome = await terminateLegacyProcess(pid, 'Mon Jan 01 00:00:00 1999');

    expect(outcome.status).toBe('gone');
    expect(outcome.termSent).toBe(false);
    expect(outcome.killSent).toBe(false);
    // The innocent reused process must be untouched.
    expect(isAlive(pid)).toBe(true);
  });
});
