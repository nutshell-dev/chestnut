/**
 * Phase 1273: permissionChecker injected into main runtime ExecContext
 *
 * 反向：
 * 1. main runtime ExecContext.permissionChecker !== undefined after initialize
 * 2. main agent file-tool write 实测调通 (不抛 not-injected error)
 * 3. RuntimeDependencies 缺 permissionChecker 时 tsc compile fail (type-level)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Runtime } from '../../../src/core/runtime/index.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { createMockLLMConfig } from '../_runtime-test-helpers.js';
import { createFileTools } from '../../../src/foundation/file-tool/index.js';

describe('phase 1273: permissionChecker injected into main runtime ExecContext', () => {
  let tmpDir: string;
  let clawDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-phase1273-'));
    clawDir = path.join(tmpDir, 'test-claw');
    fs.mkdirSync(clawDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('反向 1: main runtime ExecContext.permissionChecker !== undefined after initialize', async () => {
    const deps = await makeRuntimeDeps({
      clawDir,
      clawId: 'test-claw',
      llmConfig: createMockLLMConfig(),
    });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      maxSteps: 10,
      dependencies: deps,
    });
    await runtime.initialize();

    const ctx = (runtime as any).execContext;
    expect(ctx.permissionChecker).toBeDefined();
    expect(typeof ctx.permissionChecker.checkRead).toBe('function');
    expect(typeof ctx.permissionChecker.checkWrite).toBe('function');

    await runtime.stop();
  });

  it('反向 2: main agent file-tool write 实测调通 (不抛 not-injected error)', async () => {
    const deps = await makeRuntimeDeps({
      clawDir,
      clawId: 'test-claw',
      llmConfig: createMockLLMConfig(),
    });
    const runtime = new Runtime({
      clawId: 'test-claw',
      clawDir,
      llmConfig: createMockLLMConfig(),
      maxSteps: 10,
      dependencies: deps,
    });
    await runtime.initialize();

    const ctx = (runtime as any).execContext;
    const tools = createFileTools();
    const writeTool = tools.find((t: any) => t.name === 'write');
    expect(writeTool).toBeDefined();

    const result = await writeTool!.execute({ path: 'test-phase1273.txt', content: 'hello' }, ctx);
    expect(result.success).toBe(true);

    await runtime.stop();
  });

  it('反向 3 (type-level): RuntimeDependencies 缺 permissionChecker 时 tsc compile fail', () => {
    // @ts-expect-error - permissionChecker required by phase 1273
    const badDeps: import('../../../src/core/runtime/index.js').RuntimeDependencies = {};
    expect(badDeps).toBeDefined(); // 运行时占位，编译期由 @ts-expect-error 验证
  });
});
