import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRunRootTeardown,
  reclaimStaleRunRoots,
} from '../../.config/vitest-global-setup.js';
import type { RunManifest } from '../../.config/vitest-global-setup.js';
import { getRunRoot, getRunSubDir, getHostTmpDir } from './run-root.js';
import { createTrackedTempDir, cleanupTempDir } from './temp.js';
import { beginRetentionScope } from './resource-retention.js';

const RESOURCE_FAILURE_MARKER = 'test-resource-failures.jsonl';
const RECLAIM_STALE_FIXTURE_AGE_MS = 11 * 60 * 1000;
const CURRENT_INVOCATION_ID = 'current-unit-test-invocation';
const FIXTURE_BYTES = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]);

function createManifest(runRoot: string, invocationId = 'historical-unit-test-invocation'): RunManifest {
  return {
    invocationId,
    pid: process.pid,
    worktree: process.cwd(),
    startedAt: new Date().toISOString(),
    runRoot,
  };
}

function createReclaimFixture(
  hostTmpdir: string,
  name: string,
  options: {
    manifest?: 'valid' | 'missing' | 'corrupt';
    invocationId?: string;
    ownerAlive?: boolean;
  } = {},
): { runRoot: string; markerPath: string; fixturePath: string } {
  const runRoot = path.join(hostTmpdir, `chestnut-run-${name}`);
  fs.mkdirSync(runRoot);
  const fixturePath = path.join(runRoot, 'fixture.bin');
  fs.writeFileSync(fixturePath, FIXTURE_BYTES);

  const manifestKind = options.manifest ?? 'valid';
  if (manifestKind === 'corrupt') {
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), '{"invocationId":');
  } else if (manifestKind === 'valid') {
    const manifest = createManifest(runRoot, options.invocationId ?? name);
    // A live PID with a removed worktree is dead under the original owner rule;
    // this also stays dead through the git-failure fallback.
    manifest.worktree = options.ownerAlive
      ? process.cwd()
      : path.join(hostTmpdir, `removed-worktree-${name}`);
    fs.writeFileSync(
      path.join(runRoot, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  }

  return { runRoot, markerPath: path.join(runRoot, RESOURCE_FAILURE_MARKER), fixturePath };
}

function makeRunRootStale(runRoot: string): void {
  const stale = new Date(Date.now() - RECLAIM_STALE_FIXTURE_AGE_MS);
  fs.utimesSync(runRoot, stale, stale);
}

async function withReclaimHost(
  name: string,
  run: (
    hostTmpdir: string,
    fixture: ReturnType<typeof createReclaimFixture>,
  ) => void,
  options: Parameters<typeof createReclaimFixture>[2] = {},
): Promise<void> {
  const hostTmpdir = await createTrackedTempDir('reclaim-run-root-host-');
  const fixture = createReclaimFixture(hostTmpdir, name, options);
  try {
    run(hostTmpdir, fixture);
  } finally {
    await cleanupTempDir(hostTmpdir);
  }
}

async function withKeepTestTmp<T>(keep: boolean, run: () => Promise<T>): Promise<T> {
  const originalKeep = process.env.CHESTNUT_KEEP_TEST_TMP;
  if (keep) process.env.CHESTNUT_KEEP_TEST_TMP = '1';
  else delete process.env.CHESTNUT_KEEP_TEST_TMP;
  try {
    return await run();
  } finally {
    if (originalKeep === undefined) delete process.env.CHESTNUT_KEEP_TEST_TMP;
    else process.env.CHESTNUT_KEEP_TEST_TMP = originalKeep;
  }
}

describe('run-root utils', () => {
  it('getRunRoot returns CHESTNUT_RUN_ROOT env var', () => {
    const runRoot = getRunRoot();
    expect(runRoot).toBeDefined();
    expect(runRoot).toBe(process.env.CHESTNUT_RUN_ROOT);
  });

  it('getRunSubDir returns a child of run root', () => {
    const runRoot = getRunRoot();
    const subDir = getRunSubDir('claws');
    expect(subDir).toBeDefined();
    expect(subDir).toContain(runRoot!);
    expect(subDir).toContain('claws');
  });

  it('getHostTmpDir returns a real OS tmpdir path', () => {
    const hostTmp = getHostTmpDir();
    expect(hostTmp).toBeDefined();
    // 在 TMPDIR 被重定向的测试 invocation 中，getHostTmpDir 应不同于当前 os.tmpdir()
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    expect(hostTmp).not.toBe(os.tmpdir());
  });

  it('TMPDIR is redirected to run root', () => {
    const runRoot = getRunRoot();
    expect(process.env.TMPDIR).toBe(runRoot);
    expect(process.env.TMP).toBe(runRoot);
    expect(process.env.TEMP).toBe(runRoot);
  });

  it.each([false, true])(
    'fails and preserves a marked run root byte-for-byte (KEEP_TEST_TMP=%s)',
    async keep => {
      const runRoot = await createTrackedTempDir('marked-run-root-');
      const markerBytes = Buffer.from('{"type":"unconfirmed-direct-child","pid":123}\n');
      const markerPath = path.join(runRoot, RESOURCE_FAILURE_MARKER);
      fs.writeFileSync(markerPath, markerBytes);
      try {
        await withKeepTestTmp(keep, async () => {
          await expect(createRunRootTeardown(createManifest(runRoot))()).rejects.toThrow(
            /Resource retention requires preserving run root.*unconfirmed-direct-child/,
          );
        });
        expect(fs.existsSync(runRoot)).toBe(true);
        expect(fs.readFileSync(markerPath)).toEqual(markerBytes);
      } finally {
        await cleanupTempDir(runRoot);
      }
    },
  );

  it.each([false, true])(
    'retains the original unmarked teardown behavior (KEEP_TEST_TMP=%s)',
    async keep => {
      const runRoot = await createTrackedTempDir('unmarked-run-root-');
      try {
        await withKeepTestTmp(keep, async () => {
          await expect(createRunRootTeardown(createManifest(runRoot))()).resolves.toBeUndefined();
        });
        expect(fs.existsSync(runRoot)).toBe(keep);
      } finally {
        await cleanupTempDir(runRoot);
      }
    },
  );

  it.each([false, true])(
    'throws with the inspection cause and preserves the root on marker errors (KEEP_TEST_TMP=%s)',
    async keep => {
      const runRoot = await createTrackedTempDir('marker-inspection-error-run-root-');
      const inspectionError = Object.assign(new Error('injected marker EIO'), { code: 'EIO' });
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
        throw inspectionError;
      });
      try {
        const error = await withKeepTestTmp(keep, () =>
          createRunRootTeardown(createManifest(runRoot))().then(
            () => null,
            (caught: unknown) => caught,
          ));
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /Failed to inspect retention.*preserving run root/,
        );
        expect((error as Error).cause).toBe(inspectionError);
        expect(readSpy).toHaveBeenCalledWith(path.join(runRoot, RESOURCE_FAILURE_MARKER), 'utf8');
        expect(fs.existsSync(runRoot)).toBe(true);
      } finally {
        readSpy.mockRestore();
        await cleanupTempDir(runRoot);
      }
    },
  );

  it.each([
    ['regular', Buffer.from('{"type":"unconfirmed-direct-child","pid":123}\n')],
    ['empty', Buffer.alloc(0)],
    ['corrupt', Buffer.from('{"type":"unconfirmed-direct-child"')],
  ])('reclaim preserves a stale root with a %s marker byte-for-byte', (_kind, markerBytes) => {
    return withReclaimHost('marked', (hostTmpdir, fixture) => {
      fs.writeFileSync(fixture.markerPath, markerBytes);
      makeRunRootStale(fixture.runRoot);

      expect(() => reclaimStaleRunRoots(hostTmpdir, CURRENT_INVOCATION_ID)).not.toThrow();

      expect(fs.existsSync(fixture.runRoot)).toBe(true);
      expect(fs.readFileSync(fixture.markerPath)).toEqual(markerBytes);
      expect(fs.readFileSync(fixture.fixturePath)).toEqual(FIXTURE_BYTES);
    });
  });

  it('reclaim treats a symlink marker as evidence without following it', () => {
    return withReclaimHost('symlink-marker', (hostTmpdir, fixture) => {
      fs.symlinkSync('fixture.bin', fixture.markerPath);
      makeRunRootStale(fixture.runRoot);

      expect(() => reclaimStaleRunRoots(hostTmpdir, CURRENT_INVOCATION_ID)).not.toThrow();

      expect(fs.lstatSync(fixture.markerPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(fixture.markerPath)).toEqual(FIXTURE_BYTES);
      expect(fs.readFileSync(fixture.fixturePath)).toEqual(FIXTURE_BYTES);
    });
  });

  it('reclaim treats a same-named directory as a marker', () => {
    return withReclaimHost('directory-marker', (hostTmpdir, fixture) => {
      fs.mkdirSync(fixture.markerPath);
      makeRunRootStale(fixture.runRoot);

      expect(() => reclaimStaleRunRoots(hostTmpdir, CURRENT_INVOCATION_ID)).not.toThrow();

      expect(fs.statSync(fixture.markerPath).isDirectory()).toBe(true);
      expect(fs.readFileSync(fixture.fixturePath)).toEqual(FIXTURE_BYTES);
    });
  });

  it('teardown and reclaim release an all-completed scope stream', async () => {
    const runRoot = await createTrackedTempDir('completed-run-root-');
    const scope = beginRetentionScope({
      runRoot,
      protectedPaths: [path.join(runRoot, 'fixture')],
      label: 'completed unit scope',
    });
    scope.complete();
    await withKeepTestTmp(false, () =>
      expect(createRunRootTeardown(createManifest(runRoot))()).resolves.toBeUndefined());
    expect(fs.existsSync(runRoot)).toBe(false);
    await cleanupTempDir(runRoot);

    return withReclaimHost('completed-history', (hostTmpdir, fixture) => {
      const historical = beginRetentionScope({
        runRoot: fixture.runRoot,
        protectedPaths: [fixture.fixturePath],
        label: 'completed historical scope',
      });
      historical.complete();
      makeRunRootStale(fixture.runRoot);
      reclaimStaleRunRoots(hostTmpdir, CURRENT_INVOCATION_ID);
      expect(fs.existsSync(fixture.runRoot)).toBe(false);
    });
  });

  it('reclaim removes a stale dead-owner root when the marker is absent', () => {
    return withReclaimHost('unmarked', (hostTmpdir, fixture) => {
      makeRunRootStale(fixture.runRoot);

      expect(() => reclaimStaleRunRoots(hostTmpdir, CURRENT_INVOCATION_ID)).not.toThrow();

      expect(fs.existsSync(fixture.runRoot)).toBe(false);
    });
  });

  it('reclaim preserves the root and its bytes when marker inspection fails', () => {
    return withReclaimHost('inspection-error', (hostTmpdir, fixture) => {
      makeRunRootStale(fixture.runRoot);
      const inspectionError = Object.assign(new Error('injected reclaim marker EIO'), { code: 'EIO' });
      const originalRead = fs.readFileSync;
      const readSpy = vi.spyOn(fs, 'readFileSync')
        .mockImplementationOnce(originalRead)
        .mockImplementationOnce(() => { throw inspectionError; });
      try {
        expect(() => reclaimStaleRunRoots(hostTmpdir, CURRENT_INVOCATION_ID)).not.toThrow();

        expect(readSpy).toHaveBeenCalledWith(fixture.markerPath, 'utf8');
        expect(fs.existsSync(fixture.runRoot)).toBe(true);
        expect(fs.readFileSync(fixture.fixturePath)).toEqual(FIXTURE_BYTES);
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  it.each([
    {
      boundary: 'current invocation',
      stale: true,
      options: { invocationId: CURRENT_INVOCATION_ID },
    },
    {
      boundary: 'live owner',
      stale: true,
      options: { ownerAlive: true },
    },
    {
      boundary: 'fresh directory',
      stale: false,
      options: {},
    },
    {
      boundary: 'missing manifest',
      stale: true,
      options: { manifest: 'missing' as const },
    },
    {
      boundary: 'corrupt manifest',
      stale: true,
      options: { manifest: 'corrupt' as const },
    },
  ])('reclaim retains the original $boundary boundary', ({ stale, options }) => {
    return withReclaimHost('boundary', (hostTmpdir, fixture) => {
      if (stale) makeRunRootStale(fixture.runRoot);

      expect(() => reclaimStaleRunRoots(hostTmpdir, CURRENT_INVOCATION_ID)).not.toThrow();

      expect(fs.existsSync(fixture.runRoot)).toBe(true);
      expect(fs.readFileSync(fixture.fixturePath)).toEqual(FIXTURE_BYTES);
    }, options);
  });
});
