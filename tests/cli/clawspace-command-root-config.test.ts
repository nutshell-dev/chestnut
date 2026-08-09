/**
 * Phase 1324 Step B: clawspace read/ls RootConfig owner-reader 边界矩阵。
 *
 * 冻结（M#9 fail-loud 分流）：
 * - 普通 claw：loadGlobal 恰好一次、loadClaw(getClawConfigPath(name)) 恰好一次；
 * - missing：loadClaw → undefined 映射各自既有 CliError("does not exist")，
 *   且 fsFactory 未被访问（guard 先于任何文件系统接触）；
 * - corrupt/IO：loadClaw 抛 sentinel，同一实例原样上抛（不 catch、不伪装 missing），
 *   fsFactory 同样未被访问。
 *
 * fake Reader 由 tests/helpers/claw-command-deps.ts 每 test 构建 fresh 实例；
 * 不 mock Assembly config internal。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readCommand } from '../../src/cli/commands/claw-read.js';
import { lsCommand } from '../../src/cli/commands/claw-ls.js';
import { getClawConfigPath } from '../../src/core/claw-topology/index.js';
import { CliError } from '../../src/cli/errors.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import {
  makeClawCommandDeps,
  type FakeClawCommandDeps,
} from '../helpers/claw-command-deps.js';

type Run = (deps: FakeClawCommandDeps) => Promise<void>;

// read/ls 共用同一边界矩阵；fs stub 只够各命令走完正常路径（存在性判定之后）。
const CASES: ReadonlyArray<readonly [verb: string, run: Run, fsStub: unknown]> = [
  ['read', (deps) => readCommand(deps, 'test-claw', 'a.md'), { read: async () => 'x\n' }],
  ['ls', (deps) => lsCommand(deps, 'test-claw', undefined, {}), { list: async () => [] }],
];

describe('clawspace read/ls RootConfig 边界 (phase 1324)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it.each(CASES)('%s 普通 claw：loadGlobal 一次、loadClaw(configPath) 一次', async (_verb, run, fsStub) => {
    const deps = makeClawCommandDeps(() => fsStub as FileSystem);
    await run(deps);
    expect(deps.rootConfig.loadGlobal).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.loadClaw).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.loadClaw).toHaveBeenCalledWith(getClawConfigPath('test-claw'));
  });

  it.each(CASES)('%s missing：loadClaw → undefined 映射原 CliError 且 fsFactory 未被访问', async (_verb, run) => {
    const fsFactory = vi.fn();
    const deps = makeClawCommandDeps(fsFactory, { loadClaw: () => undefined });
    await expect(run(deps)).rejects.toThrow(new CliError('Claw "test-claw" does not exist'));
    expect(fsFactory).not.toHaveBeenCalled();
  });

  it.each(CASES)('%s corrupt/IO：loadClaw 抛 sentinel 原实例上抛且 fsFactory 未被访问', async (_verb, run) => {
    const sentinel = new Error('corrupt claw config sentinel');
    const fsFactory = vi.fn();
    const deps = makeClawCommandDeps(fsFactory, {
      loadClaw: () => {
        throw sentinel;
      },
    });
    await expect(run(deps)).rejects.toBe(sentinel);
    expect(fsFactory).not.toHaveBeenCalled();
  });
});
