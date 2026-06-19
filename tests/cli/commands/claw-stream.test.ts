/**
 * claw-stream command tests (phase 447 Step B).
 *
 * Coverage: parseStartMode (5 cases) + claw-not-exists error path.
 * Out of scope: long-running tail / signal handling / daemon liveness polling
 * (covered by e2e tests in future phase if needed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { streamCommand, parseStartMode } from '../../../src/cli/commands/claw-stream.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { loadGlobalConfig, clawExists } from '../../../src/assembly/config-load.js';
import { getClawDir, getGlobalConfigPath, getClawConfigPath } from '../../../src/foundation/config/index.js';
import { CliError } from '../../../src/cli/errors.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../../src/foundation/config/index.js', () => ({
  loadGlobalConfig: vi.fn(),
  clawExists: vi.fn(),
  getClawDir: vi.fn(),
  getGlobalConfigPath: vi.fn(),
  getClawConfigPath: vi.fn(),
}));

vi.mock('../../../src/assembly/config-load.js', async () => {
  const foundation = await import('../../../src/foundation/config/index.js');
  return {
    loadGlobalConfig: foundation.loadGlobalConfig,
    clawExists: foundation.clawExists,
    isInitialized: vi.fn(),
    saveGlobalConfig: vi.fn(),
    loadClawConfig: vi.fn(),
    saveClawConfig: vi.fn(),
    patchGlobalConfigPrimary: vi.fn(),
    buildLLMConfig: vi.fn(),
  };
});

describe('parseStartMode', () => {
  it('default (no args) → recent-turn', () => {
    expect(parseStartMode([])).toEqual({ kind: 'recent-turn' });
  });

  it('--from-now → now', () => {
    expect(parseStartMode(['--from-now'])).toEqual({ kind: 'now' });
  });

  it('--include-history → history', () => {
    expect(parseStartMode(['--include-history'])).toEqual({ kind: 'history' });
  });

  it('--from-recent-turn → recent-turn (explicit)', () => {
    expect(parseStartMode(['--from-recent-turn'])).toEqual({ kind: 'recent-turn' });
  });

  it('--from-offset 100 → offset 100', () => {
    expect(parseStartMode(['--from-offset', '100'])).toEqual({ kind: 'offset', value: 100 });
  });

  it('--from-offset 0 → offset 0 (boundary)', () => {
    expect(parseStartMode(['--from-offset', '0'])).toEqual({ kind: 'offset', value: 0 });
  });

  it('--from-offset non-integer → CliError', () => {
    expect(() => parseStartMode(['--from-offset', 'abc'])).toThrow(CliError);
    expect(() => parseStartMode(['--from-offset', 'abc'])).toThrow(/non-negative/);
  });

  it('--from-offset negative → CliError', () => {
    expect(() => parseStartMode(['--from-offset', '-5'])).toThrow(CliError);
  });

  it('--from-offset missing value → CliError', () => {
    expect(() => parseStartMode(['--from-offset'])).toThrow(CliError);
  });

  it('multiple flags: first matched wins', () => {
    expect(parseStartMode(['--from-now', '--include-history'])).toEqual({ kind: 'now' });
  });
});

describe('streamCommand', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(clawExists).mockReturnValue(true);
    vi.mocked(getClawDir).mockImplementation((name: string) => path.join('/tmp/chestnut/claws', name));
    vi.mocked(getGlobalConfigPath).mockReturnValue('/tmp/chestnut/config.yaml');
    vi.mocked(getClawConfigPath).mockImplementation((name: string) => path.join('/tmp/chestnut/claws', name, 'config.yaml'));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws CliError when claw does not exist', async () => {
    vi.mocked(clawExists).mockReturnValue(false);
    await expect(streamCommand({ fsFactory }, 'nonexistent-claw'))
      .rejects.toBeInstanceOf(CliError);
    await expect(streamCommand({ fsFactory }, 'nonexistent-claw'))
      .rejects.toThrow(/does not exist/);
  });
});
