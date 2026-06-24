import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
// phase 278: hoist 3 dyn imports
import { sendCommand } from '../../src/cli/commands/claw-send.js';
import { getGlobalConfigPath } from '../../src/assembly/global-config-path.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// Mock node-fs to spy on NodeFileSystem ctor
vi.mock('../../src/foundation/fs/node-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/fs/node-fs.js')>();
  return {
    ...actual,
    NodeFileSystem: vi.fn().mockImplementation((opts: any) => new actual.NodeFileSystem(opts)),
  };
});

// Mock config
vi.mock('../../src/assembly/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/global-config-path.js')>();
  return {
    ...actual,
    getGlobalConfigPath: vi.fn(),
  };
});
vi.mock('../../src/assembly/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config-loader.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

describe('claw-send — confinement baseDir vs root (P0.2 phase 611)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `phase611-claws-${randomUUID()}`);
    fs.mkdirSync(path.join(tmpRoot, 'claws', 'test-claw'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'claws', 'test-claw', 'config.yaml'), 'name: test-claw\n');
    process.env.CHESTNUT_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.CHESTNUT_ROOT;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('claw-send writes inbox via clawDir-confined NodeFileSystem (not baseDir=/)', async () => {

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.chestnut', 'config.yaml'));

    await sendCommand({ fsFactory }, 'test-claw', 'hello');

    // Contract (phase 611 P0.2 + phase 232)：inbox-writing NodeFileSystem 必 confined、不可 baseDir=/。
    // phase 232: fs baseDir 从 clawDir 升为 chestnutRoot（notifyClaw wrapper 需解析 claws/ namespace）。
    // 注：phase 8c83be84 加 daemon-alive 检查后、sendCommand 内会额外构造 ProcessManager 的
    //   NodeFileSystem (baseDir 不一定相同)。本测试只断 confinement 契约、不锁 ctor 计数。
    const calls = vi.mocked(NodeFileSystem).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const ctorCall of calls) {
      expect(ctorCall[0].baseDir).not.toBe('/');
    }
    // phase 232: inbox-writing fs baseDir = chestnutRoot (= path.dirname(getGlobalConfigPath()))
    const chestnutRootCall = calls.find((c) => c[0].baseDir === path.join(tmpRoot, '.chestnut'));
    expect(chestnutRootCall).toBeDefined();
  });
});
