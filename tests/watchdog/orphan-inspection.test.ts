import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { _captureProcessRefForTest } from '../../src/foundation/process-exec/index.js';
import { ensureWatchdog, WatchdogOrphanInspectionError } from '../../src/watchdog/ensure.js';
import { inspectOrphanWatchdogs } from '../../src/watchdog/orphan-sweep.js';
import { newWatchdogAttempt } from '../../src/watchdog/watchdog-ownership.js';
import { _resetWatchdogContextForTest, setAuditWriter } from '../../src/watchdog/watchdog-context.js';
import { cleanupTempDir, createTrackedTempDir } from '../utils/temp.js';

const aliveObservation = () => ({
  kind: 'alive' as const,
  evidence: { version: 1 as const, atMs: 0, facts: [] },
});

describe('Phase 2189 Step E: read-only watchdog orphan inspection', () => {
  let tempDir: string;
  let chestnutDir: string;
  let originalRoot: string | undefined;
  const factory = (baseDir: string) => new NodeFileSystem({ baseDir });

  beforeEach(async () => {
    _resetWatchdogContextForTest();
    tempDir = await createTrackedTempDir('wd-inspect-');
    chestnutDir = path.join(tempDir, '.chestnut');
    nodeFs.mkdirSync(chestnutDir, { recursive: true });
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
    setAuditWriter(new AuditWriter(factory(chestnutDir), 'audit.tsv', null));
  });

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalRoot;
    await cleanupTempDir(tempDir);
    _resetWatchdogContextForTest();
  });

  function owner(pid: number) {
    return newWatchdogAttempt(pid, {
      captureOwnedProcessRef: () => _captureProcessRefForTest(pid),
    });
  }

  function writeOwner(generation: 'active' | 'candidate' | 'retired', record: ReturnType<typeof owner>, outcome?: 'lost') {
    const dir = generation === 'active'
      ? 'watchdog/active'
      : generation === 'candidate'
        ? `watchdog/candidates/${record.attempt_id}`
        : `watchdog/retired/${record.owner_token}`;
    factory(chestnutDir).writeAtomicSync(`${dir}/owner.json`, JSON.stringify(record));
    if (outcome) {
      factory(chestnutDir).writeAtomicSync(`${dir}/outcome.json`, JSON.stringify({ outcome }));
    }
  }

  function deps(pids: number[]) {
    return {
      findProcessesAsync: vi.fn(async () => pids),
      observeProcessTarget: vi.fn(aliveObservation),
      inspectProcessRef: vi.fn(aliveObservation),
      kill: vi.fn(),
    };
  }

  it('matches a local retired generation to recovery without terminating it', async () => {
    const record = owner(21001);
    writeOwner('retired', record);
    const processDeps = deps([record.pid]);

    const report = await inspectOrphanWatchdogs(factory, processDeps);

    expect(report.kind).toBe('recovery_required');
    expect(report.decisions[0]).toMatchObject({
      kind: 'recovery',
      pid: record.pid,
      evidence: {
        workspace: { kind: 'local' },
        argv: { kind: 'match' },
        generation: { kind: 'retired', attemptId: record.attempt_id },
        ppid: { kind: 'unknown' },
      },
    });
    expect(processDeps.kill).not.toHaveBeenCalled();
  });

  it('keeps foreign and in-flight candidates out of recovery', async () => {
    const foreign = owner(21002);
    foreign.workspace_root = '/foreign/workspace';
    writeOwner('retired', foreign);
    const candidate = owner(21003);
    writeOwner('candidate', candidate);

    const report = await inspectOrphanWatchdogs(factory, deps([foreign.pid, candidate.pid]));

    expect(report.kind).toBe('clear');
    expect(report.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'blocked', pid: foreign.pid, reason: 'foreign_workspace' }),
      expect.objectContaining({ kind: 'blocked', pid: candidate.pid, reason: 'candidate_in_flight' }),
    ]));
  });

  it('fails closed when argv has no unique generation evidence', async () => {
    const report = await inspectOrphanWatchdogs(factory, deps([21004]));
    expect(report.kind).toBe('blocked');
  });

  it('blocks startup instead of spawning over an orphan that needs explicit recovery', async () => {
    const record = owner(21005);
    writeOwner('retired', record);

    await expect(ensureWatchdog(factory, deps([record.pid])))
      .rejects.toBeInstanceOf(WatchdogOrphanInspectionError);
  });

  it('reuses a live active owner while exposing separate recovery evidence', async () => {
    const active = owner(21006);
    const retired = owner(21007);
    writeOwner('active', active);
    writeOwner('retired', retired);

    const result = await ensureWatchdog(factory, deps([active.pid, retired.pid]));

    expect(result.kind).toBe('already_running');
    expect(result.startupInspection?.kind).toBe('recovery_required');
    expect(result.startupInspection?.decisions).toEqual([
      expect.objectContaining({ kind: 'recovery', pid: retired.pid }),
    ]);
  });
});
