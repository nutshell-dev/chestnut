import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { CliError, handleCliError } from '../../src/cli/errors.js';
import { parseIntOption } from '../../src/cli/parse-int-option.js';
import { findOrphans } from '../../src/core/status-service/index.js';
import { ProcessListUnavailable } from '../../src/foundation/process-manager/index.js';
import { motionStepsCommand, motionStepCommand } from '../../src/cli/commands/motion-steps.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import * as clawSteps from '../../src/cli/commands/claw-steps.js';
import { skillInstallClawCommand } from '../../src/cli/commands/skill.js';
import { createTaskStatusBar } from '../../src/cli/commands/chat-viewport-task-status-bar.js';
import { parseDurationMs, DurationParseError } from '../../src/cli/utils/duration.js';
import { chatCommand } from '../../src/cli/commands/claw-chat.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const BAN_PATTERNS = [
  // fs.(read|exists)Sync? against contract.yaml / progress.json in CLI scope
  String.raw`fs\.(read|exists)\w*Sync\?[^\n]*(contract\.yaml|progress\.json)`,
];

describe('CLI 区不得直读 contract.yaml / progress.json', () => {
  for (const pattern of BAN_PATTERNS) {
    it(`grep -rnE '${pattern}' src/cli/ 应 0 hit`, () => {
      let out = '';
      try {
        out = execSync(
          `grep -rnE '${pattern}' src/cli/`,
          { encoding: 'utf-8' },
        ).trim();
      } catch (err: any) {
        // grep exit 1 = 0 match = expected
        if (err.status !== 1) throw err;
        out = '';
      }
      expect(out, `Forbidden direct fs read of contract resource in src/cli/:\n${out}`).toBe('');
    });
  }
});

/**
 * Skill command tests
 */
describe('Phase 537 — skillInstallClawCommand traversal guard', () => {
  it('rejects traversal claw id', async () => {
    await expect(skillInstallClawCommand({ fsFactory }, '../foo', 'safe')).rejects.toThrow(/Invalid claw id/);
  });
  it('rejects traversal skill name', async () => {
    await expect(skillInstallClawCommand({ fsFactory }, 'claw1', '../foo')).rejects.toThrow(/Invalid skill name/);
  });
  it('rejects empty params', async () => {
    await expect(skillInstallClawCommand({ fsFactory }, '', 'x')).rejects.toThrow(/Invalid claw id/);
    await expect(skillInstallClawCommand({ fsFactory }, 'claw1', '')).rejects.toThrow(/Invalid skill name/);
  });
});

describe('CliError', () => {
  it('stores message and code', () => {
    const err = new CliError('test msg', 42);
    expect(err.message).toBe('test msg');
    expect(err.code).toBe(42);
    expect(err.name).toBe('CliError');
  });

  it('defaults code to 1', () => {
    const err = new CliError('msg');
    expect(err.code).toBe(1);
  });

  it('is instanceof Error', () => {
    expect(new CliError('msg')).toBeInstanceOf(Error);
  });
});

describe('handleCliError', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrSpy.mockRestore();
  });

  it('CliError with code → returns code + logs message without "Error:" prefix', () => {
    const code = handleCliError(new CliError('cli-msg', 3));
    expect(code).toBe(3);
    expect(consoleErrSpy).toHaveBeenCalledWith('cli-msg');
  });

  it('CliError default code → returns 1', () => {
    const code = handleCliError(new CliError('cli-msg'));
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('cli-msg');
  });

  it('generic Error → returns 1 + logs "Error: <msg>"', () => {
    const code = handleCliError(new Error('boom'));
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('Error:', 'boom');
  });

  it('string throw → returns 1 + logs "Error: <string>"', () => {
    const code = handleCliError('plain-string');
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('Error:', 'plain-string');
  });

  it('non-Error object → returns 1 + logs "Error: <stringified>"', () => {
    const obj = { foo: 'bar' };
    const code = handleCliError(obj);
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith('Error:', String(obj));
  });
});

describe('parseIntOption (Layer A validation)', () => {
  it('parses a valid integer string', () => {
    expect(parseIntOption('10', '--limit must be a non-negative integer')).toBe(10);
    expect(parseIntOption('1704067200000', '--since must be a Unix timestamp in milliseconds')).toBe(1704067200000);
    expect(parseIntOption('0', '--limit must be a non-negative integer')).toBe(0);
  });

  it('throws CliError for non-numeric --limit', () => {
    expect(() => parseIntOption('abc', '--limit must be a non-negative integer'))
      .toThrow('--limit must be a non-negative integer, got: abc');
  });

  it('throws CliError for non-numeric --since with "Unix timestamp in milliseconds" semantic context', () => {
    expect(() => parseIntOption('xyz', '--since must be a Unix timestamp in milliseconds'))
      .toThrow('--since must be a Unix timestamp in milliseconds, got: xyz');
  });

  it('throws CliError for empty string', () => {
    expect(() => parseIntOption('', '--limit must be a non-negative integer'))
      .toThrow('--limit must be a non-negative integer, got: ');
  });

  // phase 366 L2 (review-2026-06-13): strict 守、不再 silent 截断 trailing 非数字
  it('phase 366 L2: rejects mixed alphanumeric string (no silent truncation)', () => {
    expect(() => parseIntOption('12abc', '--limit must be a non-negative integer'))
      .toThrow('--limit must be a non-negative integer, got: 12abc');
  });

  it('phase 366 L2: rejects float syntax', () => {
    expect(() => parseIntOption('12.5', '--limit must be a non-negative integer'))
      .toThrow('--limit must be a non-negative integer, got: 12.5');
  });

  it('phase 366 L2: accepts negative integer', () => {
    expect(parseIntOption('-5', '--limit must be a non-negative integer')).toBe(-5);
  });
});

/**
 * Phase 1478: orphan-helper logic moved into core/status-service/forum-aggregators
 * (as `findOrphans`). These tests cover the same surface via the new location;
 * the prior `findOrphanProcesses` symbol in src/cli/commands/status.ts is gone.
 */
describe('findOrphans (status-service)', () => {
  it('returns empty array on ProcessListUnavailable (graceful skip)', () => {
    const pm = { findProcesses: () => { throw new ProcessListUnavailable('test'); } };
    expect(findOrphans(pm as any, '/path', [1, 2])).toEqual([]);
  });

  it('rethrows non-ProcessListUnavailable errors', () => {
    const pm = { findProcesses: () => { throw new Error('other'); } };
    expect(() => findOrphans(pm as any, '/path', [])).toThrow('other');
  });

  it('excludes given PIDs and process.pid', () => {
    const pm = { findProcesses: () => [1, 2, 3, process.pid] };
    expect(findOrphans(pm as any, '/path', [2])).toEqual([1, 3]);
  });
});

describe('motion-steps', () => {
  let clawStepsSpy: ReturnType<typeof vi.spyOn>;
  let clawStepSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    clawStepsSpy = vi.spyOn(clawSteps, 'clawStepsCommand').mockResolvedValue(undefined);
    clawStepSpy = vi.spyOn(clawSteps, 'clawStepCommand').mockResolvedValue(undefined);
  });

  afterEach(() => {
    clawStepsSpy.mockRestore();
    clawStepSpy.mockRestore();
  });

  it('motionStepsCommand 等价 clawStepsCommand("motion")', async () => {
    await motionStepsCommand({ fsFactory });
    expect(clawStepsSpy).toHaveBeenCalledWith(expect.objectContaining({ fsFactory: expect.any(Function) }), 'motion', expect.any(Object));
    expect(clawStepsSpy).toHaveBeenCalledTimes(1);
  });

  it('motionStepCommand("1") 等价 clawStepCommand("1", "motion")', async () => {
    await motionStepCommand({ fsFactory }, '1');
    expect(clawStepSpy).toHaveBeenCalledWith(expect.objectContaining({ fsFactory: expect.any(Function) }), '1', 'motion');
    expect(clawStepSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * chat-viewport shutdown parallelization (phase 908 B2)
 *
 * Covers:
 * - Promise.all schema replaces serial for...of await
 * - Parallel stop timing: 3 × 100ms resolves in < 200ms total
 */
describe('chat-viewport shutdown parallelization (B2)', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(__dirname, '../../src/cli/commands/chat-viewport.ts');
  const sourceCode = fs.readFileSync(sourcePath, 'utf-8');

  it('source uses Promise.all for taskWatchMap shutdown', () => {
    const cleanupStart = sourceCode.indexOf('await exitPromise;');
    expect(cleanupStart).toBeGreaterThan(-1);
    const cleanupBlock = sourceCode.slice(cleanupStart, cleanupStart + 2000);

    expect(cleanupBlock).toContain('Promise.all(');
    expect(cleanupBlock).toContain('taskWatchMap.values()');
    // old serial pattern removed
    expect(cleanupBlock).not.toMatch(
      /for\s*\(\s*const\s+tw\s+of\s+taskWatchMap\.values\(\)\s*\)\s*await\s+tw\.streamReader\?\.stop\(\)/
    );
  });

  it('Promise.all resolves 3 × SETTLE_MS stops in < 2 × SETTLE_MS (parallel vs serial)', async () => {
    // phase 1176: per-promise settle duration（test-local fixture）
    const SETTLE_MS = 100;
    const start = Date.now();
    await Promise.all(
      Array.from({ length: 3 }).map(() => new Promise<void>(r => setTimeout(r, SETTLE_MS)))
    );
    const elapsed = Date.now() - start;
    // parallel ≈ SETTLE_MS（1×）/ serial would be ≈ 3 × SETTLE_MS / 2 × SETTLE_MS 是区分上界
    expect(elapsed).toBeLessThan(SETTLE_MS * 2);
  });
});

describe('phase 940 r117 B fork — empty tool name silent fall-through fix', () => {
  it('tool_call without name → currentTool null (no tool active)', () => {
    const bar = createTaskStatusBar({ updateRender: () => {} });
    bar.addTrack('task-1', 'spawn_subagent');
    bar.updateTrack('task-1', { type: 'tool_call' }); // 无 name field
    const line = bar.renderSpawn(80);
    // null currentTool → 走 ⊙ ghost branch + 不显 tool name
    expect(line).toContain('⊙');
    expect(line).not.toContain('⚙');
  });

  it('tool_call with empty string name → currentTool null', () => {
    const bar = createTaskStatusBar({ updateRender: () => {} });
    bar.addTrack('task-1', 'spawn_subagent');
    bar.updateTrack('task-1', { type: 'tool_call', name: '' });
    const line = bar.renderSpawn(80);
    expect(line).toContain('⊙'); // 空串视为无 tool
    expect(line).not.toContain('⚙');
  });

  it('tool_call with valid name → currentTool string + ⚙ branch', () => {
    const bar = createTaskStatusBar({ updateRender: () => {} });
    bar.addTrack('task-1', 'spawn_subagent');
    bar.updateTrack('task-1', { type: 'tool_call', name: 'read' });
    const line = bar.renderSpawn(80);
    expect(line).toContain('⚙');
    expect(line).toContain('read');
  });
});

/**
 * Minimum acceptable TASK_STALE_TIMEOUT_MS expressed in minutes.
 * Derivation: 实测 kimi-k2.5 thinking 单调 latency 5.29min / ×4 safety = 21min /
 * 选 20 留小 fudge / 防 regression 误改回 5min；当前 src 实然 30min, 下限 20.
 */
const MIN_STALE_TIMEOUT_MINUTES = 20;

/** Sample regression value (5min) intentionally below MIN — 反向自检. */
const REGRESSION_TIMEOUT_MINUTES = 5;

// phase 1401 Bug B invariant: TASK_STALE_TIMEOUT_MS 必 ≥ 20min。
// 实测 kimi-k2.5 thinking 单调 latency 5.29min；5min 阈值会误杀长 LLM 首调。
// 30min 是当前选定值，下限 20min 留 fudge 给后续微调；防 regression 误改回 5min。
describe('phase 1401: TASK_STALE_TIMEOUT_MS 必 >= 20min', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const FILE = `${ROOT}/src/cli/commands/chat-viewport.ts`;

  it('常量声明 minutes 系数 ≥ 20', () => {
    const src = readFileSync(FILE, 'utf-8');
    const m = src.match(/TASK_STALE_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
    expect(m, 'TASK_STALE_TIMEOUT_MS 必声明为 N * 60 * 1000 格式').not.toBeNull();
    const minutes = Number(m![1]);
    expect(minutes).toBeGreaterThanOrEqual(MIN_STALE_TIMEOUT_MINUTES);
  });

  it('反向自检 — 5 应被拦', () => {
    const sample = `const TASK_STALE_TIMEOUT_MS = ${REGRESSION_TIMEOUT_MINUTES} * 60 * 1000;`;
    const m = sample.match(/TASK_STALE_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
    expect(Number(m![1])).toBe(REGRESSION_TIMEOUT_MINUTES);
    expect(Number(m![1])).toBeLessThan(MIN_STALE_TIMEOUT_MINUTES);
  });
});

// phase 1401 Bug A invariant: task stream reader 必从 0 catch-up，不从 EOF tail。
// 防 regression 误改回 `taskReader.start();`（默认 EOF）让 shadow 早期事件
// (task_attempt_start / turn_start / llm_start) 漏读，间接触发 stale-sweep 误杀。
describe('phase 1401: task stream reader catch-up from 0', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const FILE = `${ROOT}/src/cli/commands/chat-viewport-event-handler.ts`;

  it('taskReader.start(0) explicit — 不 fall back EOF tail', () => {
    const src = readFileSync(FILE, 'utf-8');
    expect(src).toMatch(/taskReader\.start\(0\)/);
    expect(src).not.toMatch(/taskReader\.start\(\s*\)\s*;/);
  });

  it('反向自检 — sample 含 start() 应被命中', () => {
    const badSample = 'taskReader.start();';
    expect(/taskReader\.start\(\s*\)\s*;/.test(badSample)).toBe(true);
    const goodSample = 'taskReader.start(0);';
    expect(/taskReader\.start\(\s*\)\s*;/.test(goodSample)).toBe(false);
    expect(/taskReader\.start\(0\)/.test(goodSample)).toBe(true);
  });
});

/**
 * phase 5: duration parser unit tests.
 */
describe('parseDurationMs', () => {
  it('parses seconds', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDurationMs('5m')).toBe(5 * 60_000);
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('1h')).toBe(60 * 60_000);
    expect(parseDurationMs('24h')).toBe(24 * 60 * 60_000);
  });

  it('trims whitespace', () => {
    expect(parseDurationMs(' 5m ')).toBe(5 * 60_000);
  });

  it('rejects zero', () => {
    expect(() => parseDurationMs('0s')).toThrow(DurationParseError);
  });

  it('rejects negative (regex hits)', () => {
    expect(() => parseDurationMs('-5m')).toThrow(DurationParseError);
  });

  it('rejects unknown unit', () => {
    expect(() => parseDurationMs('5d')).toThrow(DurationParseError);
  });

  it('rejects empty', () => {
    expect(() => parseDurationMs('')).toThrow(DurationParseError);
  });

  it('rejects bare number', () => {
    expect(() => parseDurationMs('5')).toThrow(DurationParseError);
  });
});

describe('claw-chat', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('chestnut-chat-test-');
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;

    // Create global config so loadGlobalConfig passes
    const configPath = path.join(tmpDir, '.chestnut', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n',
    );
  });

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalRoot;
    await cleanupTempDir(tmpDir);
  });

  it('error msg contains Try guidance hint when claw does not exist (phase 981 E-α2)', async () => {
    await expect(chatCommand({ fsFactory }, 'nonexistent-claw')).rejects.toThrow(/Try `chestnut claw list`/);
  });
});
