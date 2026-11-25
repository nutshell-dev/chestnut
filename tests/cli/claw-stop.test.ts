/**
 * claw-stop command tests (phase 1124 Step B: P1-18 failure-path marker cleanup)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stopCommand } from '../../src/cli/commands/claw-stop.js';
import { CliError } from '../../src/cli/errors.js';
import { getClawConfigPath, getChestnutRoot, makeChestnutRoot } from '../../src/foundation/claw-identity/index.js';
import { resolveClawDaemonDir } from '../../src/core/claw-topology/index.js';
import { createProcessManagerForCLI, signalCleanStop, clearCleanStop } from '../../src/foundation/process-manager/index.js';
import { makeClawCommandDeps, type FakeClawCommandDeps } from '../helpers/claw-command-deps.js';

const fsFactory = (baseDir: string) => ({
  writeAtomic: vi.fn(),
  delete: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readBytesSync: vi.fn(),
} as any);

// phase 1864 Step B：路径群归 foundation/claw-identity（mock 面按 owner 拆两处）。
vi.mock('../../src/foundation/claw-identity/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/index.js')>();
  return {
    ...actual,
    getClawConfigPath: vi.fn(),
    getChestnutRoot: vi.fn(),
    makeChestnutRoot: vi.fn(),
  };
});

vi.mock('../../src/core/claw-topology/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/index.js')>();
  return {
    ...actual,
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

    vi.mocked(signalCleanStop).mockResolvedValue({ kind: 'durable' });
    vi.mocked(clearCleanStop).mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('stop success → clean-stop marker kept + success audit', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
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

  it('stop intent_recorded reports unconfirmed exit instead of stopped', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      stop: vi.fn().mockResolvedValue({ kind: 'intent_recorded' }),
    } as any);

    await stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any });

    expect(mockAudit.write).toHaveBeenCalledWith(
      'cli_claw_stop',
      'name=test-claw',
      'status=intent_recorded',
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Claw "test-claw" stop intent recorded; daemon exit not confirmed',
    );
    expect(consoleLogSpy).not.toHaveBeenCalledWith('✓ Stopped Claw "test-claw"');
    expect(clearCleanStop).not.toHaveBeenCalled();
  });

  it('stop failure → clean-stop marker removed + CliError still thrown（含 stage 证据）', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
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

  it('stop success + marker write failure → non-clean terminal, no success audit', async () => {
    vi.mocked(signalCleanStop).mockRejectedValue(new Error('marker read-only'));
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      stop: vi.fn().mockResolvedValue({ kind: 'stopped', pid: 123, via: 'sigterm' }),
    } as any);

    await expect(stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any }))
      .rejects.toThrow('without clean-stop proof');

    expect(mockAudit.write).toHaveBeenCalledWith(
      'cli_claw_stop',
      'name=test-claw',
      'status=clean_stop_marker_unknown',
      expect.stringContaining('path='),
      expect.stringContaining('operation_id='),
      expect.stringContaining('marker read-only'),
    );
    expect(mockAudit.write).not.toHaveBeenCalledWith(
      'cli_claw_stop',
      'name=test-claw',
      'status=success',
    );
    expect(consoleLogSpy).not.toHaveBeenCalledWith('✓ Stopped Claw "test-claw"');
  });

  it('post-rename durability unknown → stopped-but-unproven terminal', async () => {
    vi.mocked(signalCleanStop).mockResolvedValue({
      kind: 'committed_durability_unknown',
      error: Object.assign(new Error('directory fsync failed'), { code: 'EIO' }),
    });
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      stop: vi.fn().mockResolvedValue({ kind: 'stopped', pid: 123, via: 'sigterm' }),
    } as any);

    await expect(stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any }))
      .rejects.toThrow('clean-stop marker unknown');
  });

  it('stop failure + marker cleanup failure → both facts reach caller', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      stop: vi.fn().mockResolvedValue({ kind: 'failed', stage: 'signal', reason: 'kill EPERM' }),
    } as any);
    vi.mocked(clearCleanStop).mockRejectedValue(new Error('marker delete EIO'));

    await expect(stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any }))
      .rejects.toThrow(/kill EPERM.*marker_cleanup_failed.*marker delete EIO/);
    expect(mockAudit.write).toHaveBeenCalledWith(
      'cli_claw_stop',
      'name=test-claw',
      'status=marker_cleanup_failed',
      'error=Error: marker delete EIO',
    );
  });

  // phase 1769: not_running 是竞态终局（alive 检查后 generation 消失），非失败
  it('stop not_running（race）→ 不 throw、status=not_running audit', async () => {
    vi.mocked(createProcessManagerForCLI).mockReturnValue({
      isAlive: vi.fn().mockReturnValue(true),
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
      isAlive: vi.fn().mockReturnValue(false),
      stop: vi.fn().mockResolvedValue({ kind: 'not_running' }),
    } as any);

    await stopCommand(commandDeps, 'test-claw', { audit: mockAudit as any });

    expect(signalCleanStop).toHaveBeenCalledTimes(1);
    expect(clearCleanStop).not.toHaveBeenCalled();
  });

  it('missing claw → existing CliError before ProcessManager construction', async () => {
    commandDeps.rootConfig.loadClaw.mockReturnValue(undefined);
    await expect(stopCommand(commandDeps, 'test-claw')).rejects.toThrow('Claw "test-claw" does not exist');
    expect(createProcessManagerForCLI).not.toHaveBeenCalled();
  });

  it('damaged global config does not affect stop and loadGlobal is not called', async () => {
    const sentinel = new Error('global config sentinel');
    commandDeps.rootConfig.loadGlobal.mockImplementation(() => { throw sentinel; });
    const stop = vi.fn().mockResolvedValue({ kind: 'stopped', pid: 123, via: 'sigterm' });
    vi.mocked(createProcessManagerForCLI).mockReturnValue({ stop } as any);

    await expect(stopCommand(commandDeps, 'test-claw')).resolves.toBeUndefined();

    expect(commandDeps.rootConfig.loadGlobal).not.toHaveBeenCalled();
    expect(commandDeps.rootConfig.loadClaw).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('claw config failure propagates the same instance', async () => {
    const sentinel = new Error('claw config sentinel');
    commandDeps.rootConfig.loadClaw.mockImplementation(() => { throw sentinel; });
    await expect(stopCommand(commandDeps, 'test-claw')).rejects.toBe(sentinel);
    expect(createProcessManagerForCLI).not.toHaveBeenCalled();
  });
});
