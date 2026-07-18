/**
 * claw-stop command tests (phase 1124 Step B: P1-18 failure-path marker cleanup)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stopCommand } from '../../src/cli/commands/claw-stop.js';
import { CliError } from '../../src/cli/errors.js';
import { loadGlobalConfig, clawExists } from '../../src/assembly/config/config-load.js';
import {
  getClawConfigPath,
  getChestnutRoot,
  makeChestnutRoot,
  resolveClawDaemonDir,
} from '../../src/core/claw-topology/index.js';
import { createProcessManagerForCLI, signalCleanStop, clearCleanStop } from '../../src/foundation/process-manager/index.js';

const fsFactory = (baseDir: string) => ({
  writeAtomic: vi.fn(),
  delete: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readBytesSync: vi.fn(),
} as any);

vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  clawExists: vi.fn(),
}));

vi.mock('../../src/core/claw-topology/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/index.js')>();
  return {
    ...actual,
    getClawConfigPath: vi.fn(),
    getChestnutRoot: vi.fn(),
    makeChestnutRoot: vi.fn(),
    resolveClawDaemonDir: vi.fn(),
  };
});

vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>();
  return {
    ...actual,
    createProcessManagerForCLI: vi.fn(),
    signalCleanStop: vi.fn(),
    clearCleanStop: vi.fn(),
  };
});

describe('claw-stop', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) };

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockAudit.write.mockClear();

    vi.mocked(loadGlobalConfig).mockReturnValue({} as any);
    vi.mocked(clawExists).mockReturnValue(true);
    vi.mocked(getClawConfigPath).mockReturnValue('/tmp/chestnut/claws/test-claw/config.yaml');
    vi.mocked(getChestnutRoot).mockReturnValue('/tmp/chestnut');
    vi.mocked(makeChestnutRoot).mockReturnValue('/tmp/chestnut' as any);
    vi.mocked(resolveClawDaemonDir).mockReturnValue('/tmp/chestnut/claws/test-claw/daemon');

    vi.mocked(signalCleanStop).mockResolvedValue(undefined);
    vi.mocked(clearCleanStop).mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('stop success → clean-stop marker kept + success audit', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
      stop: vi.fn().mockResolvedValue(true),
    } as any);

    await stopCommand({ fsFactory }, 'test-claw', { audit: mockAudit as any });

    expect(signalCleanStop).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/chestnut/claws/test-claw/daemon',
      mockAudit,
    );
    expect(clearCleanStop).not.toHaveBeenCalled();
    expect(mockAudit.write).toHaveBeenCalledWith(
      'cli_claw_stop',
      'name=test-claw',
      'status=success',
    );
  });

  it('stop failure → clean-stop marker removed + CliError still thrown', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
      stop: vi.fn().mockResolvedValue(false),
    } as any);

    await expect(stopCommand({ fsFactory }, 'test-claw', { audit: mockAudit as any }))
      .rejects.toBeInstanceOf(CliError);

    expect(signalCleanStop).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/chestnut/claws/test-claw/daemon',
      mockAudit,
    );
    expect(clearCleanStop).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/chestnut/claws/test-claw/daemon',
      mockAudit,
    );
    expect(mockAudit.write).toHaveBeenCalledWith(
      'cli_claw_stop',
      'name=test-claw',
      'status=failed',
    );
  });

  it('not running → no marker write, no cleanup, resolves', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(false),
      stop: vi.fn(),
    } as any);

    await stopCommand({ fsFactory }, 'test-claw', { audit: mockAudit as any });

    expect(signalCleanStop).not.toHaveBeenCalled();
    expect(clearCleanStop).not.toHaveBeenCalled();
  });
});
