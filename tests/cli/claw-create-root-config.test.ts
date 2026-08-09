import { describe, it, expect, vi } from 'vitest';
import { createCommand } from '../../src/cli/commands/claw-create.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';

function makeDeps(options: {
  loadGlobal?: () => any;
  loadClaw?: () => any;
  saveClaw?: (...args: any[]) => void;
} = {}) {
  const fs = {
    ensureDirSync: vi.fn(),
    writeAtomicSync: vi.fn(),
  } as unknown as FileSystem;
  return {
    fs,
    deps: {
      fsFactory: vi.fn(() => fs),
      rootConfig: {
        loadGlobal: vi.fn(options.loadGlobal ?? (() => ({}))),
        loadClaw: vi.fn(options.loadClaw ?? (() => undefined)),
        saveClaw: vi.fn(options.saveClaw ?? (() => {})),
      },
    },
  };
}

describe('claw create RootConfig boundary', () => {
  it('missing claw is created through scoped saveClaw capability', async () => {
    const { deps, fs } = makeDeps();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createCommand(deps, 'alice');

    expect(deps.rootConfig.loadGlobal).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.loadClaw).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.saveClaw).toHaveBeenCalledTimes(1);
    expect(deps.fsFactory).toHaveBeenCalledTimes(1);
    expect(fs.writeAtomicSync).toHaveBeenCalledTimes(1);
  });

  it('existing claw fails before filesystem mutation or save', async () => {
    const { deps } = makeDeps({ loadClaw: () => ({ name: 'alice' }) });
    await expect(createCommand(deps, 'alice')).rejects.toThrow('already exists');
    expect(deps.fsFactory).not.toHaveBeenCalled();
    expect(deps.rootConfig.saveClaw).not.toHaveBeenCalled();
  });

  it('global config error propagates before existence read', async () => {
    const sentinel = new Error('global sentinel');
    const { deps } = makeDeps({ loadGlobal: () => { throw sentinel; } });
    await expect(createCommand(deps, 'alice')).rejects.toBe(sentinel);
    expect(deps.rootConfig.loadClaw).not.toHaveBeenCalled();
  });

  it('claw config error propagates before filesystem mutation', async () => {
    const sentinel = new Error('claw sentinel');
    const { deps } = makeDeps({ loadClaw: () => { throw sentinel; } });
    await expect(createCommand(deps, 'alice')).rejects.toBe(sentinel);
    expect(deps.fsFactory).not.toHaveBeenCalled();
    expect(deps.rootConfig.saveClaw).not.toHaveBeenCalled();
  });
});
