import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * Phase 1269 Step B — ProcessExec 公共表面与「无跨层 raw kill」架构断言
 *
 * - execWithHandle spawn 必须 detached（隔离进程组），否则负 PGID 终止无意义。
 * - 负 PGID（进程组）信号只允许出现在 L1 process-exec 模块内；业务模块只传
 *   ExecutionIdentity、消费 ExecutionTerminationOutcome。
 * - L2/L4 调用方不得绕过 handle.terminate() 直接 child.kill（Step B 锁定
 *   command-tool / tools；async-task-system 由 Step E describe 锁定）。
 */
describe('phase 1269 Step B: process-exec group termination invariants', () => {
  const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));

  function listTsFiles(dir: string, excludeDir?: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (excludeDir !== undefined && full === excludeDir) continue;
        out.push(...listTsFiles(full, excludeDir));
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('execWithHandle spawns detached (isolated process group)', () => {
    const execSrc = readFileSync(`${SRC_ROOT}/foundation/process-exec/exec.ts`, 'utf8');
    expect(execSrc).toMatch(/detached:\s*true/);
  });

  it('negative-PGID (process group) signals only exist inside L1 process-exec', () => {
    const l1Dir = `${SRC_ROOT}/foundation/process-exec`;
    const offenders = listTsFiles(SRC_ROOT, l1Dir).filter((file) =>
      /process\.kill\(-/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no cross-layer raw child.kill in command-tool / tools', () => {
    const offenders = [
      ...listTsFiles(`${SRC_ROOT}/foundation/command-tool`),
      ...listTsFiles(`${SRC_ROOT}/foundation/tools`),
    ].filter((file) => /\.child\.kill\(/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('L1 index exports identity/termination types and recovery entry, not KillEscalator', () => {
    const indexSrc = readFileSync(`${SRC_ROOT}/foundation/process-exec/index.ts`, 'utf8');
    expect(indexSrc).toContain('terminateExecutionGroup');
    expect(indexSrc).toContain('ExecutionIdentity');
    expect(indexSrc).not.toContain('KillEscalator');
  });
});

/**
 * Phase 1269 Step E — async-task-system 终止所有权静态断言：迁移 exec 的
 * 运行期与恢复期终止必须全部经 L1（handle.terminate / terminateExecutionGroup），
 * L4 业务路径禁止 raw child.kill / process.kill。
 */
describe('phase 1269 Step E: async-task-system termination ownership', () => {
  const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));

  it('no raw child.kill / process.kill in async-exec-wrapper / task-recovery', () => {
    const files = [
      `${SRC_ROOT}/core/async-task-system/async-exec-wrapper.ts`,
      `${SRC_ROOT}/core/async-task-system/task-recovery.ts`,
    ];
    const offenders = files.filter((file) =>
      /\.child\.kill\(|process\.kill\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Phase 1269 Step F — persisted-identity 归属证明静态锁：v1 identity 的
 * verified_alive 只能来自创建不变量（detached spawn ⇒ PGID === leader PID）
 * + leader 存活/start time 匹配，禁止重新引入任何 OS PGID 查询 API
 * （Node v20 不存在该 API，Step E 的类型逃逸在生产恒 indeterminate）。
 *
 * 注意：本文件自身不得包含被禁字面量（验收反向 grep 覆盖 tests/），故拼接。
 */
describe('phase 1269 Step F: persisted identity ownership proof invariants', () => {
  const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));

  it('L1 recovery path contains no OS PGID query API', () => {
    const forbidden = ['get', 'pgid'].join('');
    const files = [
      `${SRC_ROOT}/foundation/process-exec/execution-group.ts`,
      `${SRC_ROOT}/foundation/process-exec/exec.ts`,
    ];
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(forbidden));
    expect(offenders).toEqual([]);
  });

  it('v1 identity runtime guard enforces the creation invariant (PGID === leader PID)', () => {
    const src = readFileSync(`${SRC_ROOT}/foundation/process-exec/execution-group.ts`, 'utf8');
    expect(src).toContain('leaderPid === processGroupId');
    expect(src).toContain('invalid_execution_identity');
  });

  it('disk schema enforces the creation invariant as a second guard layer', () => {
    const src = readFileSync(`${SRC_ROOT}/core/async-task-system/task-schemas.ts`, 'utf8');
    expect(src).toContain('e.processGroupId === e.leaderPid');
  });
});

/**
 * Phase 1269 Step C — abort 所有权静态断言：AbortSignal 不得再交回 spawn
 * （Node native signal 路径会提前 AbortError settle 并撤销清理），必须由 L1
 * 自己的 listener 走统一 terminate 状态机。
 */
describe('phase 1269 Step C: exec abort ownership invariants', () => {
  const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));

  it('exec.ts never hands AbortSignal to spawn and owns abort via listener', () => {
    const execSrc = readFileSync(`${SRC_ROOT}/foundation/process-exec/exec.ts`, 'utf8');
    expect(execSrc).not.toContain('signal: options.signal');
    expect(execSrc).toContain("addEventListener('abort'");
  });

  it('ProcessExecError carries structured termination facts (no message re-parsing needed)', () => {
    const errorsSrc = readFileSync(`${SRC_ROOT}/foundation/process-exec/errors.ts`, 'utf8');
    expect(errorsSrc).toContain('termination?: ExecutionTerminationFact');
  });
});
