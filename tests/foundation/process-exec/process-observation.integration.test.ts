import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { observeProcess } from '../../../src/foundation/process-exec/process-observation.js';

const supported = process.platform === 'darwin' || process.platform === 'linux';

describe.skipIf(!supported)(`real process observation (${process.platform}; POSIX only)`, () => {
  it('observes an owned process after ready, then gone after close', async () => {
    const child = spawn(process.execPath, ['-e', `
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
      process.stdout.write('ready\\n');
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Attach close/error handling before any asynchronous work, including ready.
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      const ready = once(child.stdout, 'data');
      const failed = once(child, 'error').then(([error]) => { throw error; });
      const ended = closed.then(() => { throw new Error('child closed before ready'); });
      const [data] = await Promise.race([ready, failed, ended]);
      expect(data.toString()).toBe('ready\n');
      expect(child.pid).toBeDefined();
      const alive = observeProcess(child.pid!);
      expect(alive.kind, JSON.stringify(alive)).toBe('alive');
      expect(alive.evidence.map(fact => fact.operation)).toEqual(['signal0', 'start_time', 'signal0']);
      child.stdin.end();
      expect(await closed).toEqual({ code: 0, signal: null });
      const gone = observeProcess(child.pid!);
      expect(gone.kind, JSON.stringify(gone)).toBe('gone');
      expect(gone.evidence).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });
});
