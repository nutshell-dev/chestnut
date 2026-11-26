import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, realpath } from 'node:fs/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  exec,
  observeProcessCwd,
  ProcessExecError,
  type ProcessEvidence,
} from '../../../src/foundation/process-exec/index.js';
import type { ExecResult } from '../../../src/foundation/process-exec/types.js';
import { createTrackedTempDir } from '../../utils/temp.js';

const PID = 12345;
const EXPECTED_CWD_QUERY_TIMEOUT_MS = 2000;
const evidence: ProcessEvidence = { version: 1, atMs: 0, facts: [] };
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!original) throw new Error('process.platform descriptor is missing');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function result(stdout: string): ExecResult {
  return { output: stdout, stdout, exitCode: 0 };
}

describe('process cwd query', () => {
  it('uses bounded absolute lsof execution and parses NUL-separated cwd fields exactly', async () => {
    await onPlatform('darwin', async () => {
      const stdout = `p${PID}\0\nfcwd\0n/work/space \0\n`;
      const execute = vi.fn<typeof exec>().mockResolvedValue(result(stdout));

      const observation = await observeProcessCwd(PID, execute);

      expect(execute).toHaveBeenCalledExactlyOnceWith(
        '/usr/sbin/lsof',
        ['-a', '-p', String(PID), '-d', 'cwd', '-F0pfn'],
        { cwd: '/', timeout: EXPECTED_CWD_QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      );
      expect(observation).toMatchObject({ kind: 'observed', cwd: '/work/space ' });
      expect(observation.evidence.facts).toHaveLength(1);
    });
  });

  it('allows record-separating newlines only before fields', async () => {
    await onPlatform('darwin', async () => {
      const accepted = vi.fn<typeof exec>().mockResolvedValue(
        result(`p${PID}\0\nfcwd\0\nn/work/one\0\n`),
      );
      await expect(observeProcessCwd(PID, accepted)).resolves.toMatchObject({
        kind: 'observed', cwd: '/work/one',
      });
      expect(accepted).toHaveBeenCalledTimes(1);

      const rejected = vi.fn<typeof exec>().mockResolvedValue(
        result(`p${PID}\n\0fcwd\0n/work/one\0\n`),
      );
      await expect(observeProcessCwd(PID, rejected)).resolves.toMatchObject({
        kind: 'unknown', reason: 'query_failed',
      });
      expect(rejected).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['empty output', ''],
    ['a different PID', `p${PID + 1}\0fcwd\0n/work\0\n`],
    ['a different file group', `p${PID}\0ftxt\0n/work\0\n`],
    ['a relative path', `p${PID}\0fcwd\0nwork\0\n`],
    ['a missing path', `p${PID}\0fcwd\0\n`],
    ['an extra PID record', `p${PID}\0p${PID}\0fcwd\0n/work\0\n`],
    ['multiple cwd groups', `p${PID}\0fcwd\0n/work/one\0\nfcwd\0n/work/two\0\n`],
  ])('reports unknown for %s without trimming or guessing', async (_name, stdout) => {
    await onPlatform('darwin', async () => {
      const execute = vi.fn<typeof exec>().mockResolvedValue(result(stdout));

      const observation = await observeProcessCwd(PID, execute);

      expect(observation).toMatchObject({ kind: 'unknown', reason: 'query_failed' });
      expect(observation.evidence.facts).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN].flatMap(pid =>
    (['darwin', 'linux', 'win32'] as const).map(platform => [pid, platform] as const),
  ))(
    'rejects invalid PID %s on %s before querying',
    async (pid, platform) => {
      await onPlatform(platform, async () => {
        const execute = vi.fn<typeof exec>();

        await expect(observeProcessCwd(pid, execute)).resolves.toMatchObject({
          kind: 'unknown', reason: 'incomplete_data',
        });
        expect(execute).not.toHaveBeenCalled();
      });
    },
  );

  it.each(['linux', 'win32'] as const)(
    'reports unimplemented host %s without querying lsof',
    async platform => {
      await onPlatform(platform, async () => {
        const execute = vi.fn<typeof exec>();

        const observation = await observeProcessCwd(PID, execute);

        expect(observation).toMatchObject({ kind: 'unknown', reason: 'unsupported' });
        expect(observation.evidence.facts[0]).toMatchObject({
          properties: expect.arrayContaining([
            expect.objectContaining({
              key: 'platform',
              descriptor: expect.objectContaining({ kind: 'data', value: platform }),
            }),
          ]),
        });
        expect(execute).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    ['EPERM', 'permission_denied'],
    ['EACCES', 'permission_denied'],
    ['ETIMEDOUT', 'timed_out'],
    ['ENOENT', 'query_failed'],
    ['ENOBUFS', 'query_failed'],
  ] as const)('maps query %s to %s', async (code, reason) => {
    await onPlatform('darwin', async () => {
      const execute = vi.fn<typeof exec>().mockRejectedValue(Object.assign(new Error(code), { code }));

      const observation = await observeProcessCwd(PID, execute);

      expect(observation).toMatchObject({ kind: 'unknown', reason });
      expect(JSON.stringify(observation.evidence)).toContain(code);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it('maps the bounded executor timeout fact to timed_out', async () => {
    await onPlatform('darwin', async () => {
      const timeout = new ProcessExecError({
        message: 'timed out',
        termination: {
          status: 'gone', trigger: 'timeout', termSent: true, killSent: true,
          completedAt: new Date(0).toISOString(), evidence,
        },
      });
      const execute = vi.fn<typeof exec>().mockRejectedValue(timeout);

      await expect(observeProcessCwd(PID, execute)).resolves.toMatchObject({
        kind: 'unknown', reason: 'timed_out',
      });
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it('never infers process exit from an lsof exit status', async () => {
    await onPlatform('darwin', async () => {
      const execute = vi.fn<typeof exec>().mockRejectedValue(new ProcessExecError({
        message: 'lsof exited', exitCode: 1,
      }));

      const observation = await observeProcessCwd(PID, execute);

      expect(observation).toMatchObject({ kind: 'unknown', reason: 'query_failed' });
      expect(observation).not.toHaveProperty('kind', 'gone');
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(originalPlatformDescriptor);
});

describe.skipIf(process.platform !== 'darwin')('real macOS process cwd observation', () => {
  it('observes two child PIDs bound to distinct working directories and reaps them', async () => {
    const root = await createTrackedTempDir('process-cwd-');
    const directories = [`${root}/one`, `${root}/two`];
    await Promise.all(directories.map(directory => mkdir(directory)));
    const children = directories.map(cwd => spawn(process.execPath, ['-e', `
      process.stdin.resume();
      process.stdout.write('ready\\n');
    `], { cwd, stdio: ['pipe', 'pipe', 'pipe'] }));
    const closed = children.map(child => new Promise<{
      code: number | null; signal: NodeJS.Signals | null;
    }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    }));

    try {
      await Promise.all(children.map(async child => {
        const ready = once(child.stdout, 'data');
        const failed = once(child, 'error').then(([error]) => { throw error; });
        const [data] = await Promise.race([ready, failed]);
        expect(data.toString()).toBe('ready\n');
      }));

      for (const [index, child] of children.entries()) {
        expect(child.pid).toBeDefined();
        const observation = await observeProcessCwd(child.pid!);
        expect(observation.kind, JSON.stringify(observation)).toBe('observed');
        if (observation.kind !== 'observed') continue;
        expect(observation.cwd).toBe(await realpath(directories[index]!));
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await Promise.all(closed);
    }
  });
});
