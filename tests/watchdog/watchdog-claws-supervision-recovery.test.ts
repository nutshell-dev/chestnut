import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  CLAWS_SUPERVISION_RETRY_BASE_MS,
  clawsSupervisionRetryDelayMs,
  coveredClawsSupervisionState,
  observeClawsDirectory,
  reduceClawsDirectoryObservation,
} from '../../src/watchdog/claws-observation.js';
import {
  _resetWatchdogContextForTest,
  clawsSupervisionStateAPI,
} from '../../src/watchdog/watchdog-context.js';
import { loadWatchdogState, saveWatchdogState } from '../../src/watchdog/watchdog-state.js';
import { WATCHDOG_PATHS } from '../../src/watchdog/layout.js';
import { runWatchdogLoop, _resetShutdownGuard } from '../../src/watchdog/watchdog.js';
import { createProcessManagerForCLI } from '../../src/foundation/process-manager/index.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { setTimeout as setTimeoutP } from 'timers/promises';
import { aliveLiveness } from '../helpers/liveness-fixtures.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';

vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>();
  return { ...actual, createProcessManagerForCLI: vi.fn() };
});
vi.mock('timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

describe('watchdog claws supervision recovery', () => {
  let workspaceDir: string;
  let chestnutDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    workspaceDir = path.join(os.tmpdir(), `wd-claws-recovery-${randomUUID()}`);
    chestnutDir = path.join(workspaceDir, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    previousRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = workspaceDir;
    _resetWatchdogContextForTest();
    _resetShutdownGuard();
  });

  afterEach(() => {
    _resetWatchdogContextForTest();
    _resetShutdownGuard();
    if (previousRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = previousRoot;
    vi.restoreAllMocks();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('fresh instance 从原子 state 恢复失败 evidence、计数和 retry deadline', () => {
    const nodeFs = getNodeFs();
    vi.spyOn(nodeFs, 'listSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const observation = observeClawsDirectory(nodeFs, 1_000);
    const reduced = reduceClawsDirectoryObservation(coveredClawsSupervisionState(), observation);
    clawsSupervisionStateAPI.replace(reduced.state);
    saveWatchdogState(fsFactory);

    const persisted = JSON.parse(fs.readFileSync(path.join(chestnutDir, WATCHDOG_PATHS.state), 'utf8'));
    expect(persisted.schema_version).toBe(4);
    expect(persisted.clawsSupervision).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 1,
      nextRetryAtMs: 1_000 + CLAWS_SUPERVISION_RETRY_BASE_MS,
      lastFailure: { code: 'EACCES', reason: 'permission_denied' },
    });

    _resetWatchdogContextForTest();
    expect(clawsSupervisionStateAPI.snapshot().status).toBe('covered');
    loadWatchdogState(fsFactory);

    expect(clawsSupervisionStateAPI.snapshot()).toEqual(reduced.state);
    expect(JSON.parse(fs.readFileSync(path.join(chestnutDir, WATCHDOG_PATHS.state), 'utf8')))
      .toEqual(persisted);
  });

  it('只有成功枚举才提交 recovered，并保留上次失败 evidence', () => {
    const nodeFs = getNodeFs();
    vi.spyOn(nodeFs, 'listSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('I/O failed'), { code: 'EIO' });
      })
      .mockImplementationOnce(() => []);
    const failed = observeClawsDirectory(nodeFs, 2_000);
    const degraded = reduceClawsDirectoryObservation(coveredClawsSupervisionState(), failed);
    const recoveredObservation = observeClawsDirectory(nodeFs, degraded.state.nextRetryAtMs);
    const recovered = reduceClawsDirectoryObservation(degraded.state, recoveredObservation);

    expect(recovered.transition).toBe('recovered');
    expect(recovered.state).toMatchObject({
      status: 'covered',
      consecutiveFailures: 0,
      nextRetryAtMs: 0,
      lastRecoveredAtMs: degraded.state.nextRetryAtMs,
      lastFailure: { code: 'EIO', reason: 'io_failed' },
    });
  });

  it('连续失败退避有界且ENOENT保持合法空目录语义', () => {
    expect(clawsSupervisionRetryDelayMs(1)).toBe(30_000);
    expect(clawsSupervisionRetryDelayMs(2)).toBe(60_000);
    expect(clawsSupervisionRetryDelayMs(20)).toBe(300_000);
    expect(observeClawsDirectory(getNodeFs(), 5_000)).toMatchObject({
      kind: 'empty',
      evidence: { outcome: 'empty', observedAtMs: 5_000 },
    });
  });

  it('只有 reserved/invalid 时仍是 available，rejected 证据不进入 clawIds', () => {
    const nodeFs = getNodeFs();
    const workDir = path.join(chestnutDir, 'claws', 'motion', 'clawspace', 'work');
    fs.mkdirSync(workDir, { recursive: true });
    const sentinel = path.join(workDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'keep me');
    fs.mkdirSync(path.join(chestnutDir, 'claws', '.trash'), { recursive: true });

    const observation = observeClawsDirectory(nodeFs, 4_000);

    expect(observation).toMatchObject({
      kind: 'available',
      clawIds: [],
      evidence: { outcome: 'available' },
    });
    expect(observation.evidence.rejected).toHaveLength(2);
    expect(observation.evidence.rejected).toEqual(expect.arrayContaining([
      { dir: '.trash', reason: 'invalid_claw_id_format' },
      { dir: 'motion', reason: 'reserved_motion' },
    ]));
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep me');
  });

  it('Watchdog rejected fingerprint 只在变化时记录且不 liveness rejected', async () => {
    const workDir = path.join(chestnutDir, 'claws', 'motion', 'clawspace', 'work');
    fs.mkdirSync(workDir, { recursive: true });
    const sentinel = path.join(workDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'keep me');
    fs.mkdirSync(path.join(chestnutDir, 'claws', '.trash'), { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, 'claws', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_PATHS.root), { recursive: true });
    fs.writeFileSync(
      path.join(chestnutDir, WATCHDOG_PATHS.config),
      'schema_version: 1\ninterval_ms: 5000\n',
    );
    const mockPm = {
      liveness: vi.fn().mockReturnValue(aliveLiveness()),
      isAlive: vi.fn().mockReturnValue(true),
      spawn: vi.fn().mockResolvedValue(9999),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../../src/foundation/process-manager/index.js').ProcessManager;
    vi.mocked(createProcessManagerForCLI).mockReturnValue(mockPm);
    const auditWrite = vi.spyOn(AuditWriter.prototype, 'write').mockImplementation(() => {});
    let sleeps = 0;
    vi.mocked(setTimeoutP).mockImplementation(async () => {
      sleeps += 1;
      if (sleeps === 2) {
        fs.rmSync(path.join(chestnutDir, 'claws', '.trash'), { recursive: true, force: true });
      }
      if (sleeps === 3) {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
        process.emit('SIGTERM');
        exitSpy.mockRestore();
      }
    });

    try {
      await runWatchdogLoop(fsFactory);
    } catch (error) {
      if ((error as Error).message !== 'exit') throw error;
    }

    expect(sleeps).toBe(3);
    const livenessTargets = vi.mocked(mockPm.liveness).mock.calls.map(call => String(call[0]));
    expect(livenessTargets.filter(target => target.endsWith(`${path.sep}claws${path.sep}alpha`))).toHaveLength(3);
    expect(livenessTargets.some(target => target.endsWith(`${path.sep}claws${path.sep}motion`))).toBe(false);
    expect(livenessTargets.some(target => target.endsWith(`${path.sep}claws${path.sep}.trash`))).toBe(false);
    const rejectedAudits = auditWrite.mock.calls.filter(([type]) => type === WATCHDOG_AUDIT_EVENTS.CLAW_SCAN);
    expect(rejectedAudits).toHaveLength(2);
    expect(rejectedAudits[0]).toEqual(expect.arrayContaining([
      WATCHDOG_AUDIT_EVENTS.CLAW_SCAN,
      expect.stringContaining('reserved_motion'),
      expect.stringContaining('invalid_claw_id_format'),
    ]));
    expect(rejectedAudits[1]).toEqual(expect.arrayContaining([
      WATCHDOG_AUDIT_EVENTS.CLAW_SCAN,
      expect.stringContaining('reserved_motion'),
    ]));
    expect(rejectedAudits[1].join(' ')).not.toContain('invalid_claw_id_format');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep me');
  });

  function getNodeFs(): NodeFileSystem {
    return new NodeFileSystem({ baseDir: chestnutDir });
  }
});
