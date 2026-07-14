import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'child_process';
import { exec, ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { PROCESS_EXEC_TIMEOUT_MAX_MS } from '../../../src/foundation/process-exec/constants.js';

// Track mock state so each test can configure execFileSync behaviour.
let mockThrow: Error | null = null;

vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>();
  return {
    ...mod,
    execFileSync: vi.fn((...args: any[]) => {
      if (mockThrow) {
        throw mockThrow;
      }
      return mod.execFileSync(...args);
    }),
    spawnSync: vi.fn(),
  };
});

// Import the SUT *after* the mock is declared.
import { getProcessStartTime } from '../../../src/foundation/process-exec/process-starttime.js';
import { findByPattern } from '../../../src/foundation/process-exec/find-by-pattern.js';

/**
 * Phase 948 site A — exec maxBuffer SIGTERM 后 pushChunk early return
 *
 * Verifies that after maxBuffer triggers SIGTERM, no additional chunks
 * are pushed into buffers during the grace period.
 */
describe('exec maxBuffer SIGTERM 后 pushChunk early return (phase 948 site A)', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = tmpdir();
  const MAX_BUFFER = 1024 * 1024; // 1MB, mirror internal PROCESS_EXEC_MAX_BUFFER

  it('SIGTERM 触发后 grace period 内 buffers 不再 push', async () => {
    // Node script that ignores SIGTERM and writes rapidly to stdout
    // using drain-based backpressure to avoid tight-loop blocking.
    // Without the early-return guard, the 1000ms grace period would allow
    // many additional chunks to accumulate in buffers after SIGTERM.
    const script = `
      process.on('SIGTERM', () => {});
      const chunk = 'x'.repeat(65536);
      function writeLoop() {
        while (process.stdout.write(chunk)) {}
        process.stdout.once('drain', writeLoop);
      }
      writeLoop();
    `;

    try {
      // phase 999 r121 P fork C.G.1: timeout 30000 → 10000 (typical runtime ~2-3s + 3-4x margin)
      await exec('node', ['-e', script], { cwd: workDir, timeout: 10000 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      const error = err as ProcessExecError;
      expect(error.maxBufferExceeded).toBe(true);
      // With the guard, output should stay close to MAX_BUFFER.
      // Without it, the 1000ms grace period could add many MBs.
      expect(error.output.length).toBeLessThanOrEqual(MAX_BUFFER + 65536 * 5);
    }
  }, 10000);
});

describe('getProcessStartTime catch filter', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockThrow = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockThrow = null;
  });

  it('gone PID: returns undefined and does NOT log to stderr', () => {
    const result = getProcessStartTime(99_999_999);
    expect(result).toBeUndefined();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('self PID: returns string', () => {
    const result = getProcessStartTime(process.pid);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('unexpected ps exit status returns undefined silently', () => {
    mockThrow = Object.assign(new Error('Command failed: ps -p 1 -o lstart='), {
      status: 2,
      code: undefined,
      signal: null,
    });

    const result = getProcessStartTime(1);
    expect(result).toBeUndefined();
    // Business-path console logging removed per Phase1179; silent path is acceptable
    expect(errSpy).not.toHaveBeenCalled();
  });
});

/**
 * findByPattern tests
 *
 * Covers degraded behaviour when the `ps` companion command fails.
 */
describe('findByPattern', () => {
  it('writes stderr when ps fails with non-ENOENT', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const mockSpawnSync = vi.mocked(spawnSync);
    mockSpawnSync.mockReturnValueOnce({
      stdout: '42\n',
      stderr: '',
      status: 0,
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);
    mockSpawnSync.mockImplementation(() => {
      throw Object.assign(new Error('Input/output error'), { code: 'EIO' });
    });

    const result = findByPattern('node');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[process-exec] ps failed'));
    expect(result).toEqual([{ pid: 42, command: '' }]);
  });
});

/**
 * Phase 1033 — L1 PROCESS_EXEC_TIMEOUT_MAX_MS align L4 config max
 *
 * Verifies that L1 process-exec timeout ceiling matches L4 tool_timeout_ms
 * schema max, eliminating silent clamp for mainstream caller values.
 */
describe('phase 1033: L1 PROCESS_EXEC_TIMEOUT_MAX_MS align L4 config max', () => {
  it('MAX = 600_000 (align L4 tool_timeout_ms schema max) (反向 1)', () => {
    expect(PROCESS_EXEC_TIMEOUT_MAX_MS).toBe(600_000);
  });

  it('MAX matches L4 config schema max (反向 2: cross-layer consistency)', async () => {
    const schemaPath = new URL(
      '../../../src/foundation/tools/config-schema.ts',
      import.meta.url
    );
    const schemaSrc = readFileSync(schemaPath, 'utf8');
    expect(schemaSrc).toMatch(/max\(600000\)/);
  });
});
