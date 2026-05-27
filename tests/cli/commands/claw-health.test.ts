/**
 * claw-health command tests (F4.6 / phase 845 Step C)
 *
 * Coverage: golden path + error path + edge case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { healthCommand } from '../../../src/cli/commands/claw-health.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
import { CliError } from '../../../src/cli/errors.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(() => ({ mtime: new Date(), size: 0, isDirectory: () => true })),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('../../../src/foundation/config/index.js', () => ({
  loadGlobalConfig: vi.fn(),
  clawExists: vi.fn(),
  getClawDir: vi.fn(),
  getGlobalConfigPath: vi.fn(),
}));

vi.mock('../../../src/foundation/process-manager/factories.js', () => ({
  createDirContext: vi.fn((deps: any) => ({ audit: { write: vi.fn() } })),
  createProcessManagerForCLI: vi.fn((deps: any) => ({ isAlive: vi.fn() })),
}));

describe('claw-health', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadGlobalConfig, clawExists, getClawDir, getGlobalConfigPath } = await import('../../../src/foundation/config/index.js');
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(clawExists).mockReturnValue(true);
    vi.mocked(getClawDir).mockImplementation((name: string) => path.join('/tmp/clawforum/claws', name));
    vi.mocked(getGlobalConfigPath).mockReturnValue('/tmp/clawforum/config.yaml');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('throws CliError when claw does not exist', async () => {
    const { clawExists } = await import('../../../src/foundation/config/index.js');
    vi.mocked(clawExists).mockReturnValue(false);
    await expect(healthCommand({ fsFactory }, 'foo')).rejects.toBeInstanceOf(CliError);
  });

  it('displays running status with inbox/outbox counts', async () => {
    const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
    } as any);

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
      const sp = String(p);
      if (sp.includes('inbox/pending')) return ['a.md', 'b.md', 'c.md'].map(n => ({ name: n, isDirectory: () => false, isFile: () => true })) as any;
      if (sp.includes('outbox/pending')) return ['x.md', 'y.md'].map(n => ({ name: n, isDirectory: () => false, isFile: () => true })) as any;
      if (sp.includes('contract/active')) {
        if (options && (options as any).withFileTypes) {
          return [{ isDirectory: () => true, name: 'c1', isFile: () => false }] as any;
        }
        return [] as any;
      }
      if (sp.includes('contract/paused')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await healthCommand({ fsFactory }, 'test-claw');

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/running/);
    expect(output).toMatch(/inbox_pending: 3/);
    expect(output).toMatch(/outbox_pending: 2/);
  });

  it('reports stopped status and 0 pending when dirs are missing', async () => {
    const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(false),
    } as any);

    vi.mocked(fs.readdirSync).mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    await healthCommand({ fsFactory }, 'test-claw');

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/stopped/);
    expect(output).toMatch(/inbox_pending: 0/);
    expect(output).toMatch(/outbox_pending: 0/);
  });

  it('reports active contract status when contract subdir has directories', async () => {
    const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
    } as any);

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
      const sp = String(p);
      if (sp.includes('inbox/pending')) return [] as any;
      if (sp.includes('outbox/pending')) return [] as any;
      if (sp.includes('contract/active')) {
        if (options && (options as any).withFileTypes) {
          return [{ isDirectory: () => true, name: 'c1' }] as any;
        }
        return ['c1'] as any;
      }
      if (sp.includes('contract/paused')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await healthCommand({ fsFactory }, 'test-claw');

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/contract: active/);
  });

  it('outputs JSON when --json flag is passed', async () => {
    const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
    } as any);

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.includes('inbox/pending')) return ['a.md'].map(n => ({ name: n, isDirectory: () => false, isFile: () => true })) as any;
      if (sp.includes('outbox/pending')) return ['x.md'].map(n => ({ name: n, isDirectory: () => false, isFile: () => true })) as any;
      if (sp.includes('contract/active')) return [] as any;
      if (sp.includes('contract/paused')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await healthCommand({ fsFactory }, 'test-claw', { json: true });

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe('test-claw');
    expect(parsed.status).toBe('running');
    expect(parsed.inbox_pending).toBe(1);
    expect(parsed.outbox_pending).toBe(1);
    expect(parsed.contract).toBe('none');
    expect(parsed.last_active).toBeNull();
    expect(typeof parsed.as_of).toBe('string');
  });

  describe('phase 906 Step B3: 3 catch narrow ENOENT', () => {
    it('inbox ENOENT silent — 0 throw', async () => {
      const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
      vi.mocked(createProcessManagerForCLI).mockReturnValue({
        isAlive: vi.fn().mockReturnValue(false),
      } as any);

      vi.mocked(fs.readdirSync).mockImplementation(() => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      // healthCommand 不 throw、inboxPending=0
      await expect(healthCommand({ fsFactory }, 'test-claw')).resolves.toBeUndefined();
    });

    it('inbox EACCES → throw (bubble to handleCliError)', async () => {
      const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
      vi.mocked(createProcessManagerForCLI).mockReturnValue({
        isAlive: vi.fn().mockReturnValue(false),
      } as any);

      vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike) => {
        if (String(p).includes('inbox/pending')) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        throw new Error(`Unexpected readdirSync: ${String(p)}`);
      });

      await expect(healthCommand({ fsFactory }, 'test-claw')).rejects.toThrow();
    });

    it('outbox EACCES → throw', async () => {
      const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
      vi.mocked(createProcessManagerForCLI).mockReturnValue({
        isAlive: vi.fn().mockReturnValue(false),
      } as any);

      vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike) => {
        const sp = String(p);
        if (sp.includes('inbox/pending')) return [] as any;
        if (sp.includes('outbox/pending')) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        throw new Error(`Unexpected readdirSync: ${sp}`);
      });

      await expect(healthCommand({ fsFactory }, 'test-claw')).rejects.toThrow();
    });

    it('contract sub-dir EACCES → throw', async () => {
      const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
      vi.mocked(createProcessManagerForCLI).mockReturnValue({
        isAlive: vi.fn().mockReturnValue(false),
      } as any);

      vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
        const sp = String(p);
        if (sp.includes('inbox/pending')) return [] as any;
        if (sp.includes('outbox/pending')) return [] as any;
        if (sp.includes('contract/active')) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        if (sp.includes('contract/paused')) return [] as any;
        throw new Error(`Unexpected readdirSync: ${sp}`);
      });

      await expect(healthCommand({ fsFactory }, 'test-claw')).rejects.toThrow();
    });

    it('contract scan ENOENT silent — 0 throw', async () => {
      const { createProcessManagerForCLI } = await import('../../../src/foundation/process-manager/factories.js');
      vi.mocked(createProcessManagerForCLI).mockReturnValue({
        isAlive: vi.fn().mockReturnValue(false),
      } as any);

      vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
        const sp = String(p);
        if (sp.includes('inbox/pending')) return [] as any;
        if (sp.includes('outbox/pending')) return [] as any;
        if (sp.includes('contract/active') || sp.includes('contract/paused')) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        throw new Error(`Unexpected readdirSync: ${sp}`);
      });

      await expect(healthCommand({ fsFactory }, 'test-claw')).resolves.toBeUndefined();
    });
  });
});
