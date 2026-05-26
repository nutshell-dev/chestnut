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
vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    loadGlobalConfig: vi.fn(),
  };
});

vi.mock('../../src/cli/utils/factories.js', () => ({
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
    expect(block).toContain('.action(withCliErrorHandling(async () => {');
    expect(block).toContain('await motionStepsCommand({ fsFactory });');
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

  it('pm.stop returns false → console emits ✗ + process.exitCode = 1', async () => {
    mockPmState.isAlive.mockReturnValue(true);
    mockPmState.stop.mockResolvedValue(false);

    await stopCommand({ fsFactory });

    expect(consoleSpy).toHaveBeenCalledWith('✗ Failed to stop Motion');
    expect(process.exitCode).toBe(1);
  });

  it('pm.stop returns true → console emits ✓ + process.exitCode 不变', async () => {
    mockPmState.isAlive.mockReturnValue(true);
    mockPmState.stop.mockResolvedValue(true);

    await stopCommand({ fsFactory });

    expect(consoleSpy).toHaveBeenCalledWith('✓ Stopped Motion daemon');
    expect(process.exitCode).toBe(0);
  });
});

describe('phase 922: motion.ts failed branch 源码结构验证', () => {
  const motionSource = fs.readFileSync(motionPath, 'utf-8');

  it('stop failed branch 包含 ✗ sentinel', () => {
    expect(motionSource).toContain("console.log('✗ Failed to stop Motion')");
  });

  it('stop failed branch 包含 process.exitCode = 1', () => {
    expect(motionSource).toContain('process.exitCode = 1');
  });
});
