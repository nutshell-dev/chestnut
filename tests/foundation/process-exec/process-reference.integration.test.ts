import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  captureCurrentProcessRef,
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRef,
} from '../../../src/foundation/process-exec/index.js';

const supported = process.platform === 'darwin' || process.platform === 'linux';

function json<T>(value: T): string {
  return JSON.stringify(value);
}

describe.skipIf(!supported)(`real process references (${process.platform}; POSIX only)`, () => {
  it('round-trips the current process reference and observes it alive', () => {
    const captured = captureCurrentProcessRef();
    expect(captured.kind, json(captured)).toBe('captured');
    if (captured.kind !== 'captured') return;
    const persisted = JSON.parse(json(captured)) as typeof captured;
    const decoded = decodeProcessRef(persisted.value);
    expect(decoded.kind, json(decoded)).toBe('decoded');
    if (decoded.kind !== 'decoded') return;
    const inspected = inspectProcessRef(decoded.value);
    expect(inspected.kind, json(inspected)).toBe('alive');
    expect(JSON.parse(json(inspected))).toEqual(inspected);
  });

  it('observes an owned legacy child as absent only after close', async () => {
    const child = spawn(process.execPath, ['-e', `
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
      process.stdout.write('ready\\n');
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      const decoded = decodeProcessRef({ version: 0, pid: child.pid, startTime: undefined });
      expect(decoded.kind, json(decoded)).toBe('decoded');
      if (decoded.kind !== 'decoded') return;
      const ref: ProcessRef = decoded.value;
      child.stdin.end();
      expect(await closed).toEqual({ code: 0, signal: null });
      const gone = inspectProcessRef(ref);
      expect(gone.kind, json(gone)).toBe('gone');
      expect(gone).toMatchObject({ reason: 'absent' });
      expect(json(gone)).toContain('legacy-v0');
      expect(JSON.parse(json(gone))).toEqual(gone);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });
});
