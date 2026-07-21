/**
 * claw-list command tests (F4.7 / phase 845 Step C)
 *
 * Coverage: golden path + error path + edge case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../../helpers/daemon-dir.js';
import * as fs from 'fs';
import * as path from 'path';
import { listCommand } from '../../../src/cli/commands/claw-list.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
// phase 270: hoist 7 dynamic imports of 3 unique modules
import { loadGlobalConfig } from '../../../src/assembly/config/config-load.js';
import { getGlobalConfigPath } from '../../../src/assembly/config/global-config-path.js';
import { createProcessManagerForCLI } from '../../../src/foundation/process-manager/factories.js';
import { formatRelativeTime, getLastActiveMs } from '../../../src/cli/commands/claw-shared.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(() => ({ mtime: new Date(), size: 0, isDirectory: () => true, isFile: () => true })),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('../../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getClawDir: vi.fn((id: string) => `/tmp/test-root/claws/${id}`),
    getNamedSubrootDir: vi.fn((name: string) => `/tmp/test-root/${name}`),
    getClawConfigPath: vi.fn((id: string) => `/tmp/test-root/claws/${id}/config.yaml`),
  };
});
vi.mock('../../../src/assembly/config/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/assembly/config/global-config-path.js')>();
  return {
    ...actual,
    getGlobalConfigPath: vi.fn(),
  };
});
vi.mock('../../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

vi.mock('../../../src/foundation/audit/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/foundation/audit/index.js')>()),
  createDirContext: vi.fn((deps: any) => ({ audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} })),
}));

vi.mock('../../../src/foundation/process-manager/factories.js', () => ({
  createProcessManagerForCLI: vi.fn((deps: any) => ({ isAlive: vi.fn(), readPid: vi.fn() })),
}));

vi.mock('../../../src/cli/commands/claw-shared.js', () => ({
  formatRelativeTime: vi.fn((ms: number) => `${Math.floor(ms / 60000)}m`),
  getLastActiveMs: vi.fn().mockResolvedValue(Date.now() - 300_000),
  LLM_OUTPUT_EVENTS: new Set(['thinking_delta', 'text_delta', 'tool_call']),
}));

describe('claw-list', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(getGlobalConfigPath).mockReturnValue('/tmp/chestnut/config.yaml');

    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(false),
      readPid: vi.fn().mockResolvedValue({ status: 'missing' }),
    } as any);

    vi.mocked(formatRelativeTime).mockImplementation((ms: number) => `${Math.floor(ms / 60000)}m`);
    vi.mocked(getLastActiveMs).mockResolvedValue(Date.now() - 300_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists all claws with status', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn((dir: string) => dir.includes('claw-a')),
      readPid: vi.fn((dir: string) =>
        dir.includes('claw-a')
          ? Promise.resolve({ status: 'valid', pid: FAKE_LIVE_PID })
          : Promise.resolve({ status: 'missing' }),
      ),
    } as any);

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.endsWith('config.yaml')) return true;
      if (sp.includes('contract/active') || sp.includes('contract/paused')) return false;
      return true;
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
      const sp = String(p);
      if (sp.endsWith('claws')) return ['claw-a', 'claw-b'].map(n => ({ name: n, isDirectory: () => true, isFile: () => false })) as any;
      if (sp.endsWith('outbox/pending')) return [] as any;
      if (sp.includes('contract')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await listCommand({ fsFactory });

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/claw-a.*running/);
    expect(output).toMatch(/claw-b.*stopped/);
    expect(output).toMatch(/Total: 2 claws \(1 running\)/);
  });

  it('handles 0 claws gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
      const sp = String(p);
      if (sp.endsWith('claws')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await listCommand({ fsFactory });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No claws'));
  });

  it('throws when loadGlobalConfig throws (outside try-catch)', async () => {
    vi.mocked(loadGlobalConfig).mockImplementation(() => {
      throw new Error('config corrupt');
    });

    await expect(listCommand()).rejects.toThrow('config corrupt');
  });

  it('reports contract status and outbox count', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
      readPid: vi.fn().mockResolvedValue({ status: 'valid', pid: 9999 }),
    } as any);

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.endsWith('config.yaml')) return true;
      if (sp.includes('contract.yaml')) {
        return sp.includes('active/c1');
      }
      if (sp.includes('contract/active')) return true;
      if (sp.includes('contract/paused')) return false;
      return true;
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
      const sp = String(p);
      if (sp.endsWith('claws')) return ['claw-c'].map(n => ({ name: n, isDirectory: () => true, isFile: () => false })) as any;
      if (sp.endsWith('outbox/pending')) return ['o1.md', 'o2.md', 'o3.md'].map(n => ({ name: n, isDirectory: () => false, isFile: () => true })) as any;
      if (sp.endsWith('contract/active')) {
        return [{ isDirectory: () => true, name: 'c1', isFile: () => false }] as any;
      }
      if (sp.endsWith('contract/paused')) {
        return [] as any;
      }
      if (sp.endsWith('c1')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.includes('contract.yaml')) return 'title: Test Contract\n' as any;
      throw new Error(`Unexpected readFileSync: ${sp}`);
    });

    await listCommand({ fsFactory });

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/claw-c/);
    expect(output).toMatch(/running/);
    expect(output).toMatch(/active/);
    expect(output).toMatch(/3\s+5m/); // outbox count 3, last active ~5m
  });

  it('outputs JSON when --json flag is passed', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn((dir: string) => dir.includes('claw-a')),
      readPid: vi.fn((dir: string) =>
        dir.includes('claw-a')
          ? Promise.resolve({ status: 'valid', pid: FAKE_LIVE_PID })
          : Promise.resolve({ status: 'missing' }),
      ),
    } as any);

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.endsWith('config.yaml')) return true;
      if (sp.includes('contract/active') || sp.includes('contract/paused')) return false;
      return true;
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
      const sp = String(p);
      if (sp.endsWith('claws')) return ['claw-a', 'claw-b'].map(n => ({ name: n, isDirectory: () => true, isFile: () => false })) as any;
      if (sp.endsWith('outbox/pending')) return [] as any;
      if (sp.includes('contract')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await listCommand({ fsFactory }, { json: true });

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.claws)).toBe(true);
    expect(parsed.claws).toHaveLength(2);
    expect(parsed.claws[0].name).toBe('claw-a');
    expect(parsed.claws[0].status).toBe('running');
    expect(parsed.claws[0].pid).toBe(12345);
    expect(typeof parsed.claws[0].last_active === 'string' || parsed.claws[0].last_active === null).toBe(true);
    if (parsed.claws[0].last_active !== null) {
      expect(parsed.claws[0].last_active).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(parsed.claws[1].name).toBe('claw-b');
    expect(parsed.claws[1].status).toBe('stopped');
    expect(parsed.claws[1].pid).toBeNull();
    expect(parsed.total).toBe(2);
    expect(parsed.running_count).toBe(1);
    expect(typeof parsed.as_of).toBe('string');
  });

  // phase 1151: claw list must ignore regular files in claws/ container and use topology enumeration
  it('ignores regular files in claws/ and only lists directory claws', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(false),
      readPid: vi.fn().mockResolvedValue({ status: 'missing' }),
    } as any);

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.includes('.DS_Store/config.yaml')) {
        const err = Object.assign(new Error(`ENOTDIR: not a directory, access '${sp}'`), { code: 'ENOTDIR' });
        throw err;
      }
      if (sp.endsWith('config.yaml')) return true;
      if (sp.includes('contract/active') || sp.includes('contract/paused')) return false;
      return true;
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
      const sp = String(p);
      if (sp.endsWith('claws')) {
        return [
          { name: 'claw-a', isDirectory: () => true, isFile: () => false },
          { name: '.DS_Store', isDirectory: () => false, isFile: () => true },
        ] as any;
      }
      if (sp.endsWith('outbox/pending')) return [] as any;
      if (sp.includes('contract')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await expect(listCommand({ fsFactory })).resolves.not.toThrow();

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/claw-a/);
    expect(output).not.toMatch(/\.DS_Store/);
    expect(output).toMatch(/Total: 1 claw/);
  });
});
