import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

import { ProcessListUnavailable } from '../../../src/foundation/process-exec/index.js';
import {
  findProcessesAsync,
  findProcessesDetailedAsync,
} from '../../../src/foundation/process-manager/find.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

type ChildDouble = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeContext(): ProcessManagerContext & { audit: { write: ReturnType<typeof vi.fn> } } {
  return {
    audit: { write: vi.fn(), message: (s: string) => s },
  } as unknown as ProcessManagerContext & { audit: { write: ReturnType<typeof vi.fn> } };
}

function makeChild(): ChildDouble {
  const child = new EventEmitter() as ChildDouble;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn().mockReturnValue(true);
  return child;
}

function asSpawn(child: ChildDouble): ReturnType<typeof spawn> {
  return child as unknown as ReturnType<typeof spawn>;
}

describe('process-manager bounded async find query', () => {
  it('uses the bounded query and filters the current process', async () => {
    const spawnProcess = vi.fn().mockImplementation((command: string) => {
      const child = makeChild();
      queueMicrotask(() => {
        if (command === 'pgrep') child.stdout.emit('data', Buffer.from(`${process.pid}\n123\n`));
        else child.stdout.emit('data', Buffer.from(`${process.pid} self\n 123 node orphan.js\n`));
        child.emit('close', 0, null);
      });
      return asSpawn(child);
    });
    const ctx = makeContext();
    const controller = new AbortController();

    await expect(findProcessesDetailedAsync(ctx, 'orphan', {
      timeoutMs: 100,
      maxBuffer: 4096,
      signal: controller.signal,
      spawnProcess: spawnProcess as unknown as typeof spawn,
    })).resolves.toEqual([{ pid: 123, command: 'node orphan.js' }]);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('findProcessesAsync projects detailed results to non-self PIDs', async () => {
    const spawnProcess = vi.fn().mockImplementation((command: string) => {
      const child = makeChild();
      queueMicrotask(() => {
        if (command === 'pgrep') child.stdout.emit('data', Buffer.from(`${process.pid}\n123\n`));
        else child.stdout.emit('data', Buffer.from(`${process.pid} self\n 123 node orphan.js\n`));
        child.emit('close', 0, null);
      });
      return asSpawn(child);
    });

    await expect(findProcessesAsync(makeContext(), 'orphan', {
      spawnProcess: spawnProcess as unknown as typeof spawn,
    })).resolves.toEqual([123]);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('failure audit carries reconstructable structured evidence', async () => {
    const pgrep = makeChild();
    const cause = Object.assign(new Error('spawn pgrep ENOENT'), { code: 'ENOENT' });
    const spawnProcess = vi.fn().mockReturnValue(asSpawn(pgrep));
    const ctx = makeContext();
    const pending = findProcessesDetailedAsync(ctx, 'orphan', {
      spawnProcess: spawnProcess as unknown as typeof spawn,
    });
    pgrep.stderr.emit('data', Buffer.from('lookup failed\n'));
    pgrep.emit('error', cause);

    let failure: unknown;
    try {
      await pending;
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(ProcessListUnavailable);
    expect(ctx.audit.write).toHaveBeenCalledTimes(1);
    const call = ctx.audit.write.mock.calls[0] as unknown as string[];
    expect(call[0]).toBe(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED);
    expect(call[1]).toBe('pattern=orphan');
    const evidenceColumn = call.find(column => column.startsWith('evidence='));
    expect(evidenceColumn).toBeDefined();
    const evidence = JSON.parse(evidenceColumn!.slice('evidence='.length)) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      operation: 'pgrep',
      classification: 'spawn_error',
      status: null,
      signal: null,
      stderr: 'lookup failed\n',
      code: 'ENOENT',
      errorCode: 'PROCESS_LIST_UNAVAILABLE',
      cause: { name: 'Error', message: 'spawn pgrep ENOENT', code: 'ENOENT' },
    });
  });
});
