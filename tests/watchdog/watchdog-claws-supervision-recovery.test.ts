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
  });

  afterEach(() => {
    _resetWatchdogContextForTest();
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

  function getNodeFs(): NodeFileSystem {
    return new NodeFileSystem({ baseDir: chestnutDir });
  }
});
