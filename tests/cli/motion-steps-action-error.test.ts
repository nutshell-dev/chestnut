/**
 * Phase 922 Step B3：motion 模板对称 + failed branch ✗ sentinel + exitCode
 *
 * 验证点：
 * 1. cli/index.ts motion steps + step .action() 有 try-catch + handleCliError
 * 2. motion.ts stop failed branch 输出 ✗ + 设置 process.exitCode = 1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '../../src/cli/index.ts');
const motionPath = path.join(__dirname, '../../src/cli/commands/motion.ts');
const indexSource = fs.readFileSync(indexPath, 'utf-8');

// ============================================================================
// Hoisted mock state
// ============================================================================
const mockPmState = vi.hoisted(() => ({
  isAlive: vi.fn(),
  stop: vi.fn(),
}));

// ============================================================================
// Module mocks
// ============================================================================
vi.mock('../../src/assembly/config/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/config-loader.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

vi.mock('../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn(() => mockPmState),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================
import { stopCommand } from '../../src/cli/commands/motion.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('phase 961: motion steps/step action uses withCliErrorHandling wrapper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it('motion steps .action() 使用 withCliErrorHandling wrapper（phase 961 migration）', () => {
    const stepsIdx = indexSource.indexOf("motionCmd\n  .command('steps')");
    expect(stepsIdx).toBeGreaterThan(-1);
    const block = indexSource.slice(stepsIdx, stepsIdx + 400);
    expect(block).toContain('.action(withCliErrorHandling(async (');
    expect(block).toContain('await motionStepsCommand({ fsFactory }');
    // phase 961: raw try/catch removed
    expect(block).not.toMatch(/try\s*\{/);
    expect(block).not.toContain('process.exitCode = handleCliError(error)');
  });

  it('motion step .action() 使用 withCliErrorHandling wrapper（phase 961 migration）', () => {
    const stepIdx = indexSource.indexOf("motionCmd\n  .command('step <n>')");
    expect(stepIdx).toBeGreaterThan(-1);
    const block = indexSource.slice(stepIdx, stepIdx + 400);
    expect(block).toContain('.action(withCliErrorHandling(async (n: string) => {');
    expect(block).toContain('await motionStepCommand({ fsFactory }, n);');
    // phase 961: raw try/catch removed
    expect(block).not.toMatch(/try\s*\{/);
    expect(block).not.toContain('process.exitCode = handleCliError(error)');
  });

  it('cli/index.ts 无 handleCliError 残留 usage（phase 961 import 移除）', () => {
    expect(indexSource).not.toContain('handleCliError');
  });
});

describe('phase 922: motion stop failed branch exitCode', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
    consoleSpy.mockClear();
  });

  // phase 355 C2 (review-2026-06-13): 从 console + exitCode 改 throw CliError、
  // 让 wrapper 即刻退出而非 process.exitCode race；旧期望相应更新。
  it('pm.stop returns false → throw CliError with ✗ + code=1', async () => {
    mockPmState.isAlive.mockReturnValue(true);
    mockPmState.stop.mockResolvedValue(false);

    await expect(stopCommand({ fsFactory })).rejects.toThrow(/Failed to stop Motion/);
  });

  it('pm.stop returns true → console emits ✓ + process.exitCode 不变', async () => {
    mockPmState.isAlive.mockReturnValue(true);
    mockPmState.stop.mockResolvedValue(true);

    await stopCommand({ fsFactory });

    expect(consoleSpy).toHaveBeenCalledWith('✓ Stopped Motion daemon');
    expect(process.exitCode).toBe(0);
  });
});

describe('phase 922 + phase 355 C2: motion.ts failed branch 源码结构验证', () => {
  const motionSource = fs.readFileSync(motionPath, 'utf-8');

  // phase 355 C2: failed branch 改 throw CliError、不再 console.log + exitCode
  it('stop failed branch throws CliError with ✗ sentinel + code=1', () => {
    expect(motionSource).toContain("throw new CliError('✗ Failed to stop Motion', 1)");
  });

  it('stop failed branch 不再用 process.exitCode（phase 355 C2 决策）', () => {
    expect(motionSource).not.toContain('process.exitCode = 1');
  });
});
