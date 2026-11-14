/** Phase 2153 Step B1：detached watchdog 的 raw stdout/stderr sink 装配。 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { WATCHDOG_PATHS } from '../../src/watchdog/layout.js';
import { _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { spawnWatchdogCandidate } from '../../src/watchdog/spawn.js';
import { inspectWatchdogOwner } from '../../src/watchdog/watchdog-pid.js';

const h = vi.hoisted(() => ({ spawnDetached: vi.fn() }));

vi.mock('../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-exec/index.js')>();
  return { ...actual, spawnDetached: h.spawnDetached };
});

vi.mock('../../src/watchdog/watchdog-pid.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/watchdog/watchdog-pid.js')>();
  return {
    ...actual,
    inspectWatchdogOwner: vi.fn(),
    assertWatchdogOwnerWorkspace: vi.fn(),
  };
});

const fsFactory = (baseDir: string): NodeFileSystem => new NodeFileSystem({ baseDir });
const originalRoot = process.env.CHESTNUT_ROOT;
let tmpDir: string;

beforeEach(() => {
  _resetWatchdogContextForTest();
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-spawn-output-${randomUUID()}`);
  process.env.CHESTNUT_ROOT = tmpDir;
  h.spawnDetached.mockReset();
  h.spawnDetached.mockResolvedValue({ kind: 'spawned', pid: 4242 });
  vi.mocked(inspectWatchdogOwner).mockReturnValue({
    kind: 'alive',
    source: 'active',
    pid: 4242,
    workspaceRoot: tmpDir,
  } as ReturnType<typeof inspectWatchdogOwner>);
});

afterEach(() => {
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('spawnWatchdogCandidate process output', () => {
  it('创建 watchdog owner 目录并把 raw logFile 交给 detached child', async () => {
    await expect(spawnWatchdogCandidate(fsFactory)).resolves.toBe(4242);

    expect(h.spawnDetached).toHaveBeenCalledOnce();
    const options = h.spawnDetached.mock.calls[0][2];
    const expected = path.join(tmpDir, '.chestnut', WATCHDOG_PATHS.process_output);
    expect(options.logFile).toBe(expected);
    expect(fs.statSync(path.dirname(expected)).isDirectory()).toBe(true);
  });

  it('raw sink pre-commit 打开失败仍以原 spawn failure fail-loud', async () => {
    h.spawnDetached.mockResolvedValue({
      kind: 'failed',
      failure: {
        command: 'node',
        args: ['watchdog-entry.js'],
        errno: 'EACCES',
        code: 'EACCES',
        message: 'raw sink denied',
        atMs: 123,
      },
    });

    await expect(spawnWatchdogCandidate(fsFactory))
      .rejects.toThrow(/pre-commit failure.*raw sink denied/);
    expect(h.spawnDetached.mock.calls[0][2].logFile).toBe(
      path.join(tmpDir, '.chestnut', WATCHDOG_PATHS.process_output),
    );
  });

  it('post-commit failure sink 保留 pid/errno/时间并写 stderr', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await spawnWatchdogCandidate(fsFactory);
    const options = h.spawnDetached.mock.calls[0][2];

    options.onSpawnFailure?.({
      command: 'node',
      args: ['watchdog-entry.js'],
      pid: 4242,
      errno: 'ENOENT',
      message: 'child exec failed',
      atMs: 456,
    });

    const output = stderr.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(output).toContain('pid=4242');
    expect(output).toContain('errno=ENOENT');
    expect(output).toContain('at=456');
    expect(output).toContain('child exec failed');
    const raw = fs.readFileSync(
      path.join(tmpDir, '.chestnut', WATCHDOG_PATHS.process_output),
      'utf8',
    );
    expect(raw).toContain('pid=4242');
    expect(raw).toContain('errno=ENOENT');
    expect(raw).toContain('at=456');
    expect(raw).toContain('child exec failed');
  });
});
