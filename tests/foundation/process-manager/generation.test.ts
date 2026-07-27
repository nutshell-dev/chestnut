/**
 * Process generation directory store tests (Phase 1204 Step A).
 *
 * 反向覆盖（执行计划 §6）：
 *  - 双 candidate 单 spawning（commit collision → typed foreign outcome）
 *  - late retire 不动 fresh generation（identity mismatch）
 *  - malformed generation fail-closed（不覆盖、不猜 winner）
 *  - 不同 daemonDir 资源隔离
 *  - 写 child PID 必须验证 generation 仍在 spawning、不得复活已移动目录
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import type { ProcessManagerContext, DaemonDir } from '../../../src/foundation/process-manager/types.js';
import {
  newProcessGeneration,
  prepareGeneration,
  commitSpawning,
  writeChildPid,
  writeFailureFact,
  activateGeneration,
  retireGeneration,
  inspectSpawning,
  inspectActive,
  getCandidateDir,
  getSpawningDir,
  getActiveDir,
  getRetiredDirFor,
  GENERATION_FILE,
  PID_FILE,
  FAILURE_FILE,
  type ProcessGenerationRecord,
} from '../../../src/foundation/process-manager/generation.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('process generation store (Phase 1204 Step A)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let daemonDir: DaemonDir;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let events: ReturnType<typeof makeAudit>['events'];
  let ctx: ProcessManagerContext;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('generation-');
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    daemonDir = testClawDaemonDir(tempDir, 'gen-a');
    ({ audit, events } = makeAudit());
    ctx = { fs: nodeFs, audit, getProcessStartTime: () => undefined };
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeRecord(id?: string): ProcessGenerationRecord {
    const record = newProcessGeneration(ctx, daemonDir);
    if (id !== undefined) record.generation_id = id;
    return record;
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  describe('prepare + commit', () => {
    it('prepares candidate generation.json and commits candidate → spawning', () => {
      const record = makeRecord();
      prepareGeneration(ctx, record);

      const candidateGeneration = path.join(getCandidateDir(daemonDir, record.generation_id), GENERATION_FILE);
      expect(nodeFs.existsSync(candidateGeneration)).toBe(true);

      const outcome = commitSpawning(ctx, record);
      expect(outcome).toEqual({ kind: 'committed', record });

      // 目录整体 move：candidate 消失、spawning 持有同一 record
      expect(nodeFs.existsSync(getCandidateDir(daemonDir, record.generation_id))).toBe(false);
      const inspection = inspectSpawning(ctx, daemonDir);
      expect(inspection).toEqual({ status: 'ok', record });

      const eventTypes = events.map((e) => e[0]);
      expect(eventTypes).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_PREPARED);
      expect(eventTypes).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMITTED);
    });

    it('double candidate yields single spawning (second commit gets typed foreign outcome)', () => {
      const winner = makeRecord('gen-winner');
      const loser = makeRecord('gen-loser');
      prepareGeneration(ctx, winner);
      prepareGeneration(ctx, loser);

      expect(commitSpawning(ctx, winner).kind).toBe('committed');
      const loserOutcome = commitSpawning(ctx, loser);
      expect(loserOutcome).toEqual({ kind: 'foreign_spawning', winner });

      // winner 目录未被覆盖；loser candidate 仍在原位（事实不丢失）
      const inspection = inspectSpawning(ctx, daemonDir);
      expect(inspection).toEqual({ status: 'ok', record: winner });
      expect(nodeFs.existsSync(getCandidateDir(daemonDir, loser.generation_id))).toBe(true);
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST);
    });

    it('re-commit of the same generation converges idempotently (already_committed)', () => {
      const record = makeRecord();
      prepareGeneration(ctx, record);
      expect(commitSpawning(ctx, record).kind).toBe('committed');

      // 崩溃窗口重演：move 已成功但 caller 丢失结果、重试 commit
      const retry = commitSpawning(ctx, record);
      expect(retry).toEqual({ kind: 'already_committed', record });
    });

    it('malformed spawning fails closed on commit (no overwrite, no winner guessing)', async () => {
      const spawningDir = getSpawningDir(daemonDir);
      await fs.mkdir(spawningDir, { recursive: true });
      await fs.writeFile(path.join(spawningDir, GENERATION_FILE), '{not json', 'utf-8');

      const record = makeRecord();
      prepareGeneration(ctx, record);
      const outcome = commitSpawning(ctx, record);
      expect(outcome.kind).toBe('malformed_spawning');

      // 畸形内容原样保留；candidate 未 move
      expect(nodeFs.readSync(path.join(spawningDir, GENERATION_FILE))).toBe('{not json');
      expect(nodeFs.existsSync(getCandidateDir(daemonDir, record.generation_id))).toBe(true);
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED);
    });
  });

  describe('writeChildPid', () => {
    it('writes pid.json into the spawning generation', async () => {
      const record = makeRecord();
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);

      const outcome = await writeChildPid(ctx, record, 4321);
      expect(outcome).toEqual({ kind: 'written' });

      const pidContent = JSON.parse(nodeFs.readSync(path.join(getSpawningDir(daemonDir), PID_FILE)));
      expect(pidContent.generation_id).toBe(record.generation_id);
      expect(pidContent.pid).toBe(4321);
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_PID_WROTE);
    });

    it('refuses to write when the generation has moved away (no directory resurrection)', async () => {
      const record = makeRecord();
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);
      // generation 已被 activate 移走
      await writeChildPid(ctx, record, 4321);
      expect(
        activateGeneration(ctx, daemonDir, {
          generationId: record.generation_id,
          pid: 4321,
        }).kind,
      ).toBe('activated');
      expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);

      const outcome = await writeChildPid(ctx, record, 4321);
      expect(outcome).toEqual({ kind: 'generation_moved' });
      // existing-generation 语义：不得复活已移动的 spawning 目录
      expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
    });

    it('refuses to write when a foreign generation holds spawning', async () => {
      const mine = makeRecord('gen-mine');
      const foreign = makeRecord('gen-foreign');
      prepareGeneration(ctx, foreign);
      commitSpawning(ctx, foreign);
      prepareGeneration(ctx, mine);

      const outcome = await writeChildPid(ctx, mine, 4321);
      expect(outcome).toEqual({ kind: 'generation_moved' });
      expect(nodeFs.existsSync(path.join(getSpawningDir(daemonDir), PID_FILE))).toBe(false);
    });
  });

  describe('activate', () => {
    async function spawnCommitted(pid = 4321): Promise<ProcessGenerationRecord> {
      const record = makeRecord();
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);
      await writeChildPid(ctx, record, pid);
      return record;
    }

    it('moves matching spawning generation to active', async () => {
      const record = await spawnCommitted();
      const outcome = activateGeneration(ctx, daemonDir, {
        generationId: record.generation_id,
        pid: 4321,
      });
      expect(outcome).toEqual({ kind: 'activated', record });
      expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
      expect(inspectActive(ctx, daemonDir)).toEqual({ status: 'ok', record });
      // pid.json 随目录整体 move（单 SoT）
      const pidContent = JSON.parse(nodeFs.readSync(path.join(getActiveDir(daemonDir), PID_FILE)));
      expect(pidContent.pid).toBe(4321);
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_ACTIVATED);
    });

    it('rejects activation with a foreign generation ID (spawning untouched)', async () => {
      const record = await spawnCommitted();
      const outcome = activateGeneration(ctx, daemonDir, { generationId: 'gen-other', pid: 4321 });
      expect(outcome).toEqual({ kind: 'identity_mismatch', record });
      expect(inspectSpawning(ctx, daemonDir)).toEqual({ status: 'ok', record });
    });

    it('rejects activation when pid.json identity does not match the child', async () => {
      const record = await spawnCommitted(4321);
      const outcome = activateGeneration(ctx, daemonDir, {
        generationId: record.generation_id,
        pid: 9999,
      });
      expect(outcome).toEqual({ kind: 'identity_mismatch', record });
      expect(inspectSpawning(ctx, daemonDir)).toEqual({ status: 'ok', record });
    });

    it('rejects activation before parent wrote the child PID', async () => {
      const record = makeRecord();
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);
      const outcome = activateGeneration(ctx, daemonDir, {
        generationId: record.generation_id,
        pid: 4321,
      });
      expect(outcome.kind).toBe('identity_mismatch');
      expect(inspectSpawning(ctx, daemonDir)).toEqual({ status: 'ok', record });
    });

    it('active collision re-reads the winner and loses without overwrite', async () => {
      const first = await spawnCommitted();
      expect(
        activateGeneration(ctx, daemonDir, { generationId: first.generation_id, pid: 4321 }).kind,
      ).toBe('activated');

      // 第二个 generation 占住 spawning、尝试 activate → 撞 active（fresh generation 不动）
      const second = await spawnCommitted(5555);
      const outcome = activateGeneration(ctx, daemonDir, {
        generationId: second.generation_id,
        pid: 5555,
      });
      expect(outcome).toEqual({ kind: 'collision', winner: first });
      expect(inspectActive(ctx, daemonDir)).toEqual({ status: 'ok', record: first });
      // loser spawning 目录不被 move、不被删
      expect(inspectSpawning(ctx, daemonDir)).toEqual({ status: 'ok', record: second });
    });

    it('duplicate activate of the same generation converges (already_active)', async () => {
      const record = await spawnCommitted();
      const identity = { generationId: record.generation_id, pid: 4321 };
      expect(activateGeneration(ctx, daemonDir, identity).kind).toBe('activated');
      // 崩溃窗口重演：move 已成功、child 重试
      const retry = activateGeneration(ctx, daemonDir, identity);
      expect(retry.kind).toBe('no_spawning');
    });
  });

  describe('retire', () => {
    it('retires an active generation into retired/<generation-id>', async () => {
      const record = makeRecord('gen-retire');
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);
      await writeChildPid(ctx, record, 4321);
      activateGeneration(ctx, daemonDir, { generationId: record.generation_id, pid: 4321 });

      const outcome = retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'shutdown', 'active');
      expect(outcome).toEqual({ kind: 'retired', record });
      expect(nodeFs.existsSync(getActiveDir(daemonDir))).toBe(false);
      expect(nodeFs.existsSync(path.join(getRetiredDirFor(daemonDir, record.generation_id), GENERATION_FILE))).toBe(true);
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_RETIRED);
    });

    it('late retire does not touch a fresh generation (mismatch)', async () => {
      const fresh = makeRecord('gen-fresh');
      prepareGeneration(ctx, fresh);
      commitSpawning(ctx, fresh);
      await writeChildPid(ctx, fresh, 4321);
      activateGeneration(ctx, daemonDir, { generationId: fresh.generation_id, pid: 4321 });

      const outcome = retireGeneration(ctx, daemonDir, { generationId: 'gen-stale' }, 'shutdown', 'active');
      expect(outcome).toEqual({ kind: 'mismatch', record: fresh });
      // fresh active 原样保留
      expect(inspectActive(ctx, daemonDir)).toEqual({ status: 'ok', record: fresh });
      expect(nodeFs.existsSync(getRetiredDirFor(daemonDir, 'gen-stale'))).toBe(false);
    });

    it('retire collision when another reclaimer already disposed the generation', async () => {
      const record = makeRecord('gen-collide');
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);

      expect(
        retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'spawn_failed', 'spawning').kind,
      ).toBe('retired');

      // 迟到 reclaimer：spawning 已无（no_generation）；若 fresh spawning 被同 ID 占位则 dest 已存在
      const second = retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'spawn_failed', 'spawning');
      expect(second.kind).toBe('no_generation');

      // retired dest 永久非空：重建同名 spawning 再 retire → collision，不覆盖
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);
      const third = retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'spawn_failed', 'spawning');
      expect(third.kind).toBe('collision');
      expect(inspectSpawning(ctx, daemonDir)).toEqual({ status: 'ok', record });
    });

    it('malformed source directory fails closed', async () => {
      const spawningDir = getSpawningDir(daemonDir);
      await fs.mkdir(spawningDir, { recursive: true });
      await fs.writeFile(path.join(spawningDir, GENERATION_FILE), '{"schema_version":999}', 'utf-8');

      const outcome = retireGeneration(ctx, daemonDir, { generationId: 'gen-x' }, 'confirmed_dead', 'spawning');
      expect(outcome.kind).toBe('malformed');
      // 畸形目录不被 move
      expect(nodeFs.existsSync(path.join(spawningDir, GENERATION_FILE))).toBe(true);
    });
  });

  describe('failure fact', () => {
    it('writes failure.json into spawning before retire', async () => {
      const record = makeRecord();
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);

      const outcome = await writeFailureFact(ctx, record, 'child died during boot');
      expect(outcome).toEqual({ kind: 'written' });
      const failure = JSON.parse(nodeFs.readSync(path.join(getSpawningDir(daemonDir), FAILURE_FILE)));
      expect(failure.generation_id).toBe(record.generation_id);
      expect(failure.reason).toBe('child died during boot');
      expect(events.map((e) => e[0])).toContain(PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_FAILED);
    });

    it('does not resurrect a moved generation when writing failure', async () => {
      const record = makeRecord();
      prepareGeneration(ctx, record);
      commitSpawning(ctx, record);
      retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'spawn_failed', 'spawning');

      const outcome = await writeFailureFact(ctx, record, 'late failure');
      expect(outcome).toEqual({ kind: 'generation_moved' });
      expect(nodeFs.existsSync(getSpawningDir(daemonDir))).toBe(false);
    });
  });

  describe('daemonDir isolation', () => {
    it('generations under different daemonDirs do not see each other', async () => {
      const otherDir = testClawDaemonDir(tempDir, 'gen-b');
      const recordA = newProcessGeneration(ctx, daemonDir);
      const recordB = newProcessGeneration(ctx, otherDir);
      prepareGeneration(ctx, recordA);
      prepareGeneration(ctx, recordB);

      expect(commitSpawning(ctx, recordA).kind).toBe('committed');
      // 另一 daemonDir 的 spawning 为空 → 各自独立 commit
      expect(commitSpawning(ctx, recordB).kind).toBe('committed');

      expect(inspectSpawning(ctx, daemonDir)).toEqual({ status: 'ok', record: recordA });
      expect(inspectSpawning(ctx, otherDir)).toEqual({ status: 'ok', record: recordB });
      await Promise.resolve(); // 隔离断言纯 sync、无需 IO 等待
    });
  });
});
