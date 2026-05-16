/**
 * claw-list command tests (F4.7 / phase 845 Step C)
 *
 * Coverage: golden path + error path + edge case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { listCommand } from '../../../src/cli/commands/claw-list.js';

vi.mock('fs');

vi.mock('../../../src/foundation/config/index.js', () => ({
  loadGlobalConfig: vi.fn(),
  getGlobalConfigPath: vi.fn(),
}));

vi.mock('../../../src/cli/utils/factories.js', () => ({
  createDirContext: vi.fn(() => ({ audit: { write: vi.fn() } })),
  createProcessManagerForCLI: vi.fn(() => ({ isAlive: vi.fn(), readPid: vi.fn() })),
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
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { loadGlobalConfig, getGlobalConfigPath } = await import('../../../src/foundation/config/index.js');
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(getGlobalConfigPath).mockReturnValue('/tmp/clawforum/config.yaml');

    const { createProcessManagerForCLI } = await import('../../../src/cli/utils/factories.js');
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(false),
      readPid: vi.fn().mockResolvedValue(null),
    } as any);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('lists all claws with status', async () => {
    const { createProcessManagerForCLI } = await import('../../../src/cli/utils/factories.js');
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn((name: string) => name === 'claw-a'),
      readPid: vi.fn().mockResolvedValue(12345),
    } as any);

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.endsWith('config.yaml')) return true;
      if (sp.includes('contract/active') || sp.includes('contract/paused')) return false;
      return true;
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.endsWith('claws')) return ['claw-a', 'claw-b'] as any;
      if (sp.endsWith('outbox/pending')) return [] as any;
      if (sp.includes('contract')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/claw-a.*running/);
    expect(output).toMatch(/claw-b.*stopped/);
    expect(output).toMatch(/Total: 2 claws \(1 running\)/);
  });

  it('handles 0 claws gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.endsWith('claws')) return [] as any;
      throw new Error(`Unexpected readdirSync: ${sp}`);
    });

    await listCommand();

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No claws'));
  });

  it('throws when loadGlobalConfig throws (outside try-catch)', async () => {
    const { loadGlobalConfig } = await import('../../../src/foundation/config/index.js');
    vi.mocked(loadGlobalConfig).mockImplementation(() => {
      throw new Error('config corrupt');
    });

    await expect(listCommand()).rejects.toThrow('config corrupt');
  });

  it('reports contract status and outbox count', async () => {
    const { createProcessManagerForCLI } = await import('../../../src/cli/utils/factories.js');
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
      readPid: vi.fn().mockResolvedValue(9999),
    } as any);

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const sp = String(p);
      if (sp.endsWith('config.yaml')) return true;
      if (sp.includes('contract.yaml')) {
        return sp.includes('active/c1');
      }
      if (sp.includes('contract/active') || sp.includes('contract/paused')) return false;
      return true;
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike, options?: any) => {
      const sp = String(p);
      if (sp.endsWith('claws')) return ['claw-c'] as any;
      if (sp.endsWith('outbox/pending')) return ['o1.md', 'o2.md', 'o3.md'] as any;
      if (sp.endsWith('contract/active')) {
        if (options && (options as any).withFileTypes) {
          return [{ isDirectory: () => true, name: 'c1' }] as any;
        }
        return ['c1'] as any;
      }
      if (sp.endsWith('contract/paused')) {
        if (options && (options as any).withFileTypes) {
          return [] as any;
        }
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

    await listCommand();

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/claw-c/);
    expect(output).toMatch(/running/);
    expect(output).toMatch(/active/);
    expect(output).toMatch(/3\s+5m/); // outbox count 3, last active ~5m
  });
});
