/**
 * claw-stop command tests (phase 1124 Step B: P1-18 failure-path marker cleanup)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stopCommand } from '../../src/cli/commands/claw-stop.js';
import { CliError } from '../../src/cli/errors.js';
import {
  getClawConfigPath,
  getChestnutRoot,
  makeChestnutRoot,
  resolveClawDaemonDir,
} from '../../src/core/claw-topology/index.js';
import { createProcessManagerForCLI, signalCleanStop, clearCleanStop } from '../../src/foundation/process-manager/index.js';
import { makeClawCommandDeps, type FakeClawCommandDeps } from '../helpers/claw-command-deps.js';

const fsFactory = (baseDir: string) => ({
  writeAtomic: vi.fn(),
  delete: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readBytesSync: vi.fn(),
} as any);

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
  let commandDeps: FakeClawCommandDeps;
  const mockAudit = { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) };

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockAudit.write.mockClear();

    commandDeps = makeClawCommandDeps(fsFactory);
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
      getAliveStatus: vi.fn().mockReturnValue({ alive: true, reason: 'test alive' }),
      stop: vi.fn().mockResolvedValue({ kind: 'stopped', pid: 123, via: 'sigterm' }),
    } as any);

    await stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any });

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

  it('stop failure → clean-stop marker removed + CliError still thrown（含 stage 证据）', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      getAliveStatus: vi.fn().mockReturnValue({ alive: true, reason: 'test alive' }),
      stop: vi.fn().mockResolvedValue({ kind: 'failed', stage: 'signal', reason: 'kill ESRCH' }),
    } as any);

    await expect(stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any }))
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
      'stage=signal',
      'reason=kill ESRCH',
    );
  });

  // phase 1769: not_running 是竞态终局（alive 检查后 generation 消失），非失败
  it('stop not_running（race）→ 不 throw、status=not_running audit', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      getAliveStatus: vi.fn().mockReturnValue({ alive: true, reason: 'test alive' }),
      stop: vi.fn().mockResolvedValue({ kind: 'not_running' }),
    } as any);

    await stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any });

    expect(mockAudit.write).toHaveBeenCalledWith(
      'cli_claw_stop',
      'name=test-claw',
      'status=not_running',
    );
  });

  it('not running → no marker write, no cleanup, resolves', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      getAliveStatus: vi.fn().mockReturnValue({ alive: false, reason: 'test stopped' }),
      stop: vi.fn(),
    } as any);

    await stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any });

    expect(signalCleanStop).not.toHaveBeenCalled();
    expect(clearCleanStop).not.toHaveBeenCalled();
  });

  it('missing claw → existing CliError before ProcessManager construction', async () => {
    commandDeps.rootConfig.loadClaw.mockReturnValue(undefined);
    await expect(stopCommand(commandDeps, 'test-claw')).rejects.toThrow('Claw "test-claw" does not exist');
    expect(createProcessManagerForCLI).not.toHaveBeenCalled();
  });

  it('global config failure propagates the same instance before loadClaw', async () => {
    const sentinel = new Error('global config sentinel');
    commandDeps.rootConfig.loadGlobal.mockImplementation(() => { throw sentinel; });
    await expect(stopCommand(commandDeps, 'test-claw')).rejects.toBe(sentinel);
    expect(commandDeps.rootConfig.loadClaw).not.toHaveBeenCalled();
  });

  it('claw config failure propagates the same instance', async () => {
    const sentinel = new Error('claw config sentinel');
    commandDeps.rootConfig.loadClaw.mockImplementation(() => { throw sentinel; });
    await expect(stopCommand(commandDeps, 'test-claw')).rejects.toBe(sentinel);
    expect(createProcessManagerForCLI).not.toHaveBeenCalled();
  });
});
