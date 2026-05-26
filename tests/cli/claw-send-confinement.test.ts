import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

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
vi.mock('../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/config/index.js')>();
  return {
    ...actual,
    loadGlobalConfig: vi.fn(),
    getGlobalConfigPath: vi.fn(),
    clawExists: vi.fn(() => true),
  };
});

describe('claw-send — confinement baseDir vs root (P0.2 phase 611)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `phase611-claws-${randomUUID()}`);
    fs.mkdirSync(path.join(tmpRoot, 'claws', 'test-claw'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'claws', 'test-claw', 'config.yaml'), 'name: test-claw\n');
    process.env.CLAWFORUM_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.CLAWFORUM_ROOT;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('claw-send writes inbox via clawDir-confined NodeFileSystem (not baseDir=/)', async () => {
    const { sendCommand } = await import('../../src/cli/commands/claw-send.js');
    const { NodeFileSystem } = await import('../../src/foundation/fs/node-fs.js');
    const { getGlobalConfigPath } = await import('../../src/foundation/config/index.js');

    vi.mocked(getGlobalConfigPath).mockReturnValue(path.join(tmpRoot, '.clawforum', 'config.yaml'));

    await sendCommand({ fsFactory }, 'test-claw', 'hello');

    // NodeFileSystem 应该被构造了，且 baseDir 不是 '/'，而是包含 test-claw 的目录
    expect(NodeFileSystem).toHaveBeenCalledTimes(1);
    const ctorCall = vi.mocked(NodeFileSystem).mock.calls[0];
    expect(ctorCall[0].baseDir).not.toBe('/');
    expect(ctorCall[0].baseDir).toContain('test-claw');
  });
});
