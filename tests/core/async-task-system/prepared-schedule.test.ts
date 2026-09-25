import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { rmSync, mkdirSync, statSync } from 'node:fs';

import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_CLAIMS_DIR,
} from '../../../src/core/async-task-system/dirs.js';
import { createTestTaskSystem, makeTaskSystemDeps } from '../../helpers/task-system.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { PreparedSubagentSchedule } from '../../../src/core/async-task-system/types.js';

function makeAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

function makeBasePayload(): PreparedSubagentSchedule['payload'] {
  return {
    kind: 'subagent',
    intent: 'retro summarize',
    timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
    maxSteps: 10,
    parentClawId: 'claw-1',
    mode: 'standard',
  };
}

function makePrepared(overrides?: Partial<PreparedSubagentSchedule>): PreparedSubagentSchedule {
  const id = overrides?.id ?? (`${randomUUID()}` as import('../../../src/core/async-task-system/types.js').FullTaskId);
  return {
    id,
    createdAt: '2026-07-28T00:00:00.000Z',
    payload: { ...makeBasePayload(), ...overrides?.payload },
    ...overrides,
  };
}

async function placeTaskFile(
  fs: FileSystem,
  dir: string,
  fullId: string,
  payload: PreparedSubagentSchedule['payload'],
  createdAt: string,
): Promise<void> {
  const task = {
    ...payload,
    id: fullId,
    shortId: fullId.slice(0, 8),
    createdAt,
  };
  await fs.ensureDir(dir);
  await fs.writeAtomic(`${dir}/${fullId}.json`, JSON.stringify(task, null, 2));
}

describe('AsyncTaskSystem.schedulePrepared (Phase 1206 Step A)', () => {
  let baseDir: string;
  let fs: NodeFileSystem;
  let system: AsyncTaskSystem;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(async () => {
    baseDir = await createTempDir('prepared-schedule-');
    mkdirSync(baseDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir });
    audit = makeAudit();
    system = createTestTaskSystem(baseDir, fs, audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter);
  });

  afterEach(async () => {
    await cleanupTempDir(baseDir);
  });

  it('creates a new pending task when no existing file exists', async () => {
    const prepared = makePrepared();
    const result = await system.schedulePrepared('subagent', prepared);

    expect(result.taskId).toBe(prepared.id);
    expect(result.disposition).toBe('created');

    const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`;
    const exists = await fs.exists(pendingPath);
    expect(exists).toBe(true);

    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });

  it('returns existing for identical payload in each lifecycle directory', async () => {
    const dirs = [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR];
    for (const dir of dirs) {
      rmSync(baseDir, { recursive: true, force: true });
      mkdirSync(baseDir, { recursive: true });
      fs = new NodeFileSystem({ baseDir });
      audit = makeAudit();
      system = createTestTaskSystem(baseDir, fs, audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter);

      const prepared = makePrepared();
      await placeTaskFile(fs, dir, prepared.id, prepared.payload, prepared.createdAt);

      const beforeStat = statSync(path.join(baseDir, `${dir}/${prepared.id}.json`));
      const beforeMtime = beforeStat.mtimeMs;

      const result = await system.schedulePrepared('subagent', prepared);
      expect(result.disposition).toBe('existing');
      expect(result.taskId).toBe(prepared.id);

      const afterStat = statSync(path.join(baseDir, `${dir}/${prepared.id}.json`));
      expect(afterStat.mtimeMs).toBe(beforeMtime);

      const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
      expect(scheduledEvents).toHaveLength(0);

      const confirmedEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_REPLAY_CONFIRMED);
      expect(confirmedEvents).toHaveLength(1);
    }
  });

  it('rejects when same id has different payload', async () => {
    const prepared = makePrepared();
    await placeTaskFile(fs, TASKS_QUEUES_PENDING_DIR, prepared.id, prepared.payload, prepared.createdAt);

    const conflicting = makePrepared({ id: prepared.id, payload: { ...prepared.payload, intent: 'different' } });
    await expect(system.schedulePrepared('subagent', conflicting)).rejects.toThrow(/payload hash mismatch/);

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('rejects when existing file is corrupt JSON', async () => {
    const prepared = makePrepared();
    await fs.ensureDir(TASKS_QUEUES_PENDING_DIR);
    await fs.writeAtomic(`${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`, 'not-json');

    await expect(system.schedulePrepared('subagent', prepared)).rejects.toThrow(/corrupt JSON/);

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('rejects when existing file schema mismatches', async () => {
    const prepared = makePrepared();
    await fs.ensureDir(TASKS_QUEUES_PENDING_DIR);
    await fs.writeAtomic(
      `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`,
      JSON.stringify({ id: prepared.id, shortId: prepared.id.slice(0, 8), createdAt: prepared.createdAt, kind: 'subagent' }),
    );

    await expect(system.schedulePrepared('subagent', prepared)).rejects.toThrow(/schema mismatch/);

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('rejects when task files exist in multiple lifecycle directories', async () => {
    const prepared = makePrepared();
    await placeTaskFile(fs, TASKS_QUEUES_PENDING_DIR, prepared.id, prepared.payload, prepared.createdAt);
    await placeTaskFile(fs, TASKS_QUEUES_DONE_DIR, prepared.id, prepared.payload, prepared.createdAt);

    await expect(system.schedulePrepared('subagent', prepared)).rejects.toThrow(/duplicate task files/);

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('hash is stable regardless of object key order', async () => {
    const prepared = makePrepared();
    await system.schedulePrepared('subagent', prepared);

    const reorderedPayload = {
      mode: prepared.payload.mode,
      intent: prepared.payload.intent,
      timeoutMs: prepared.payload.timeoutMs,
      maxSteps: prepared.payload.maxSteps,
      parentClawId: prepared.payload.parentClawId,
      kind: prepared.payload.kind,
    } as PreparedSubagentSchedule['payload'];
    const reordered = makePrepared({ id: prepared.id, payload: reorderedPayload });

    const result = await system.schedulePrepared('subagent', reordered);
    expect(result.disposition).toBe('existing');
  });

  it('legacy schedule() still returns shortId and writes pending', async () => {
    const payload = makeBasePayload();
    const shortId = await system.schedule('subagent', payload);
    expect(shortId).toBeTruthy();
    expect(shortId.length).toBe(8);

    const pendingFiles = await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    expect(pendingFiles.length).toBe(1);

    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });

  it('does not rewrite existing file mtime on idempotent replay', async () => {
    const prepared = makePrepared();
    await placeTaskFile(fs, TASKS_QUEUES_PENDING_DIR, prepared.id, prepared.payload, prepared.createdAt);

    const beforeStat = statSync(path.join(baseDir, `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`));
    // Allow filesystem timestamp to advance before re-checking mtime idempotency.
    const MTIME_ADVANCE_WAIT_MS = 20;
    await new Promise(r => setTimeout(r, MTIME_ADVANCE_WAIT_MS));

    await system.schedulePrepared('subagent', prepared);

    const afterStat = statSync(path.join(baseDir, `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`));
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('keeps file and emits audit when index save fails', async () => {
    const prepared = makePrepared();
    const shortIdIndex = new InMemoryShortIdIndex();
    shortIdIndex.save = () => { throw new Error('disk full'); };

    const customSystem = new AsyncTaskSystem(baseDir, fs, {
      auditWriter: audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter,
      shortIdIndex,
      ...makeTaskSystemDeps(),
    });

    const result = await customSystem.schedulePrepared('subagent', prepared);
    expect(result.disposition).toBe('created');

    const exists = await fs.exists(`${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`);
    expect(exists).toBe(true);

    const scheduledEvent = audit.events.find(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvent).toBeTruthy();
    const indexPersistedCol = scheduledEvent!.find(c => typeof c === 'string' && c.startsWith('indexPersisted='));
    expect(indexPersistedCol).toBe('indexPersisted=false');
  });
});

describe('AsyncTaskSystem.schedulePrepared concurrency (Phase 1902 Step D)', () => {
  let baseDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(async () => {
    baseDir = await createTempDir('prepared-schedule-race-');
    mkdirSync(baseDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir });
    audit = makeAudit();
  });

  afterEach(async () => {
    await cleanupTempDir(baseDir);
  });

  function makeRaceSystem(raceFs?: FileSystem): AsyncTaskSystem {
    return createTestTaskSystem(baseDir, raceFs ?? fs, audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter);
  }

  it('concurrent schedulePrepared with same payload yields exactly one created and one pending file', async () => {
    const prepared = makePrepared();
    const systems = Array.from({ length: 5 }, () => makeRaceSystem());

    const results = await Promise.all(systems.map(s => s.schedulePrepared('subagent', prepared)));

    expect(results.every(r => r.taskId === prepared.id)).toBe(true);
    expect(results.filter(r => r.disposition === 'created')).toHaveLength(1);
    expect(results.filter(r => r.disposition === 'existing')).toHaveLength(4);

    const pendingFiles = await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    expect(pendingFiles).toHaveLength(1);

    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });

  it('concurrent schedulePrepared with different payloads yields exactly one created and conflicts for the rest', async () => {
    const id = randomUUID() as import('../../../src/core/async-task-system/types.js').FullTaskId;
    const systems = Array.from({ length: 3 }, () => makeRaceSystem());

    const settled = await Promise.allSettled(systems.map((s, i) => s.schedulePrepared('subagent', makePrepared({
      id,
      payload: { ...makeBasePayload(), intent: `intent-${i}` },
    }))));

    const fulfilled = settled.filter(r => r.status === 'fulfilled');
    const rejected = settled.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ disposition: string }>).value.disposition).toBe('created');
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.message).toMatch(/payload hash mismatch/);
    }

    const pendingFiles = await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    expect(pendingFiles).toHaveLength(1);

    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });

  it('replays winner identity when the winning pending file is claimed during the EEXIST window', async () => {
    const prepared = makePrepared();
    const winnerTask = {
      ...prepared.payload,
      id: prepared.id,
      shortId: prepared.id.slice(0, 8),
      createdAt: prepared.createdAt,
    };

    // 模拟并发 winner + dispatcher：loser exclusive create 时 winner 已提交
    // pending 且被 claim 移到 running，随后报告 EEXIST。
    class WinnerClaimedFs extends NodeFileSystem {
      override async writeExclusive(p: string, content: string): Promise<void> {
        if (p.startsWith(TASKS_QUEUES_PENDING_DIR)) {
          await super.writeAtomic(p, JSON.stringify(winnerTask, null, 2));
          await super.move(p, p.replace(TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR));
          const err = new Error('file already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return super.writeExclusive(p, content);
      }
    }

    const raceSystem = makeRaceSystem(new WinnerClaimedFs({ baseDir }));
    const result = await raceSystem.schedulePrepared('subagent', prepared);

    expect(result.taskId).toBe(prepared.id);
    expect(result.disposition).toBe('existing');

    // winner 被 move 到 running 期间不重写：pending 无第二份文件
    const pendingFiles = await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    expect(pendingFiles.filter(f => f.name.startsWith(prepared.id))).toHaveLength(0);
    expect(await fs.exists(`${TASKS_QUEUES_RUNNING_DIR}/${prepared.id}.json`)).toBe(true);

    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(0);
    const replayEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_REPLAY_CONFIRMED);
    expect(replayEvents).toHaveLength(1);
  });

  it('fails closed with typed indeterminate when EEXIST conflicts but the winner never becomes readable', async () => {
    const prepared = makePrepared();

    class PhantomConflictFs extends NodeFileSystem {
      override async writeExclusive(p: string, content: string): Promise<void> {
        if (p.startsWith(TASKS_QUEUES_PENDING_DIR)) {
          const err = new Error('file already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return super.writeExclusive(p, content);
      }
    }

    const raceSystem = makeRaceSystem(new PhantomConflictFs({ baseDir }));
    await expect(raceSystem.schedulePrepared('subagent', prepared)).rejects.toThrow(/indeterminate/);

    // 绝不静默重建：任何 lifecycle 目录都没有该 id 的文件
    for (const dir of [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR]) {
      expect(await fs.exists(`${dir}/${prepared.id}.json`)).toBe(false);
    }

    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents.some(e => e.some(c => typeof c === 'string' && c.includes('indeterminate')))).toBe(true);
  });

  it('retry after index save failure replays existing without rewriting the winner file', async () => {
    const prepared = makePrepared();
    const shortIdIndex = new InMemoryShortIdIndex();
    shortIdIndex.save = () => { throw new Error('disk full'); };

    const failingSystem = new AsyncTaskSystem(baseDir, fs, {
      auditWriter: audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter,
      shortIdIndex,
      ...makeTaskSystemDeps(),
    });

    const first = await failingSystem.schedulePrepared('subagent', prepared);
    expect(first.disposition).toBe('created');

    const pendingPath = path.join(baseDir, `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`);
    const beforeMtime = statSync(pendingPath).mtimeMs;
    const MTIME_ADVANCE_WAIT_MS = 20;
    await new Promise(r => setTimeout(r, MTIME_ADVANCE_WAIT_MS));

    // index save 失败后的重试：exclusive create 已裁决 winner，replay 不覆盖
    const retrySystem = makeRaceSystem();
    const second = await retrySystem.schedulePrepared('subagent', prepared);
    expect(second.disposition).toBe('existing');
    expect(statSync(pendingPath).mtimeMs).toBe(beforeMtime);

    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });
});

describe('AsyncTaskSystem.schedulePrepared stable claim (Phase 1904 Step D)', () => {
  let baseDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(async () => {
    baseDir = await createTempDir('prepared-claim-');
    mkdirSync(baseDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir });
    audit = makeAudit();
  });

  afterEach(async () => {
    await cleanupTempDir(baseDir);
  });

  function makeSystem(raceFs?: FileSystem): AsyncTaskSystem {
    return createTestTaskSystem(baseDir, raceFs ?? fs, audit.audit as import('../../../src/foundation/audit/writer.js').AuditWriter);
  }

  /** winner 在 claim 落盘后、task 发布前崩潰（claim 已提交、task 从未发布）。 */
  class CrashAfterClaimFs extends NodeFileSystem {
    override async writeExclusive(p: string, content: string): Promise<void> {
      if (p.startsWith(TASKS_QUEUES_PENDING_DIR)) {
        throw new Error('simulated crash before task publish');
      }
      return super.writeExclusive(p, content);
    }
  }

  it('replays winner when the loser scanned empty before the winner claimed and was moved to running (barrier)', async () => {
    const prepared = makePrepared();
    const winner = makeSystem();
    const won = await winner.schedulePrepared('subagent', prepared);
    expect(won.disposition).toBe('created');
    // dispatcher 把 winner move 到 running —— pending 路径腾空
    await fs.move(
      `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`,
      `${TASKS_QUEUES_RUNNING_DIR}/${prepared.id}.json`,
    );

    // 屏障：L 的首次四态扫描看不到任何 task file（扫描发生在 W 创建之前），
    // 直到 L 自己的 claim O_EXCL 之后才恢复真实视图。
    class ScanBlindFs extends NodeFileSystem {
      private blind = true;
      override async exists(p: string): Promise<boolean> {
        if (this.blind && !p.startsWith(TASKS_QUEUES_CLAIMS_DIR)) return false;
        return super.exists(p);
      }
      override async writeExclusive(p: string, content: string): Promise<void> {
        if (p.startsWith(TASKS_QUEUES_CLAIMS_DIR)) this.blind = false;
        return super.writeExclusive(p, content);
      }
    }

    const loser = makeSystem(new ScanBlindFs({ baseDir }));
    const result = await loser.schedulePrepared('subagent', prepared);

    expect(result.taskId).toBe(prepared.id);
    expect(result.disposition).toBe('existing');
    // 不产生第二 task artifact：pending 不再出现同 id 文件
    expect(await fs.exists(`${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`)).toBe(false);
    expect(await fs.exists(`${TASKS_QUEUES_RUNNING_DIR}/${prepared.id}.json`)).toBe(true);
    const claimFiles = await fs.list(TASKS_QUEUES_CLAIMS_DIR, { includeDirs: false });
    expect(claimFiles).toHaveLength(1);
    // 不产生第二 scheduled 事实
    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });

  it('completes the winner commit from a stable claim after a crash window (claim exists, no task)', async () => {
    const prepared = makePrepared();
    const crashedWinner = makeSystem(new CrashAfterClaimFs({ baseDir }));
    await expect(crashedWinner.schedulePrepared('subagent', prepared)).rejects.toThrow(/simulated crash/);

    // claim 已提交、task 未发布、无 scheduled 事实
    expect(await fs.exists(`${TASKS_QUEUES_CLAIMS_DIR}/${prepared.id}.json`)).toBe(true);
    expect(await fs.exists(`${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`)).toBe(false);
    expect(audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED)).toHaveLength(0);

    // 同 payload 重试以 claim 身份完成 winner 的提交，不生成第二身份
    const retried = await makeSystem().schedulePrepared('subagent', prepared);
    expect(retried.taskId).toBe(prepared.id);
    expect(retried.disposition).toBe('created');

    const pendingFiles = await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    expect(pendingFiles).toHaveLength(1);
    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);

    // 再次重试只 replay
    const again = await makeSystem().schedulePrepared('subagent', prepared);
    expect(again.disposition).toBe('existing');
  });

  it('tolerates a half-written claim that completes during the reread window', async () => {
    const prepared = makePrepared();
    const crashedWinner = makeSystem(new CrashAfterClaimFs({ baseDir }));
    await expect(crashedWinner.schedulePrepared('subagent', prepared)).rejects.toThrow(/simulated crash/);

    // writeExclusive 先发布路径再完成内容写：首次读到空串，重读得到完整 claim
    class PartialClaimFs extends NodeFileSystem {
      private servedPartial = false;
      override async read(p: string): Promise<string> {
        if (!this.servedPartial && p.startsWith(TASKS_QUEUES_CLAIMS_DIR)) {
          this.servedPartial = true;
          return '';
        }
        return super.read(p);
      }
    }

    const retried = await makeSystem(new PartialClaimFs({ baseDir })).schedulePrepared('subagent', prepared);
    expect(retried.taskId).toBe(prepared.id);
    expect(retried.disposition).toBe('created');
    expect(await fs.exists(`${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`)).toBe(true);
  });

  it('fails closed on a durably corrupt claim without creating a second task', async () => {
    const prepared = makePrepared();
    await fs.ensureDir(TASKS_QUEUES_CLAIMS_DIR);
    await fs.writeAtomic(`${TASKS_QUEUES_CLAIMS_DIR}/${prepared.id}.json`, 'not-json');

    await expect(makeSystem().schedulePrepared('subagent', prepared)).rejects.toThrow(/indeterminate/);

    for (const dir of [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR]) {
      expect(await fs.exists(`${dir}/${prepared.id}.json`)).toBe(false);
    }
    const conflictEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_IDENTITY_CONFLICT);
    expect(conflictEvents.some(e => e.some(c => typeof c === 'string' && c.includes('claim is corrupt')))).toBe(true);
  });

  it('fails closed with indeterminate when claim EEXIST conflicts but the claim never becomes readable', async () => {
    const prepared = makePrepared();

    class PhantomClaimFs extends NodeFileSystem {
      override async writeExclusive(p: string, content: string): Promise<void> {
        if (p.startsWith(TASKS_QUEUES_CLAIMS_DIR)) {
          const err = new Error('file already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return super.writeExclusive(p, content);
      }
    }

    await expect(makeSystem(new PhantomClaimFs({ baseDir })).schedulePrepared('subagent', prepared)).rejects.toThrow(/indeterminate/);

    for (const dir of [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR]) {
      expect(await fs.exists(`${dir}/${prepared.id}.json`)).toBe(false);
    }
    expect(audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED)).toHaveLength(0);
  });

  it('fails closed when the stable claim and the lifecycle task disagree on payload hash', async () => {
    const prepared = makePrepared();
    await makeSystem().schedulePrepared('subagent', prepared);

    // 篡改 lifecycle task（claim 保持原 payload hash）
    const tamperedPayload = { ...prepared.payload, intent: 'tampered' };
    await placeTaskFile(fs, TASKS_QUEUES_PENDING_DIR, prepared.id, tamperedPayload, prepared.createdAt);

    // 以 tampered payload 调用：task hash 匹配、claim hash 不匹配 → fail-closed
    const tampered = makePrepared({ id: prepared.id, payload: tamperedPayload });
    await expect(makeSystem().schedulePrepared('subagent', tampered)).rejects.toThrow(/claim\/task payload hash mismatch/);
  });

  it('replays after terminal state with the stable claim in place', async () => {
    const prepared = makePrepared();
    const winner = makeSystem();
    await winner.schedulePrepared('subagent', prepared);
    await fs.move(
      `${TASKS_QUEUES_PENDING_DIR}/${prepared.id}.json`,
      `${TASKS_QUEUES_DONE_DIR}/${prepared.id}.json`,
    );

    const result = await makeSystem().schedulePrepared('subagent', prepared);
    expect(result.disposition).toBe('existing');
    expect(result.taskId).toBe(prepared.id);

    // 终态后重试不产生第二 task 或第二 scheduled 事实
    const pendingFiles = await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false });
    expect(pendingFiles.filter(f => f.name.startsWith(prepared.id))).toHaveLength(0);
    const scheduledEvents = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
    expect(scheduledEvents).toHaveLength(1);
  });

  it('backfills a stable claim once for a legacy task file and replays afterwards', async () => {
    const prepared = makePrepared();
    // 旧数据：task file 存在、无 claim
    await placeTaskFile(fs, TASKS_QUEUES_DONE_DIR, prepared.id, prepared.payload, prepared.createdAt);

    const first = await makeSystem().schedulePrepared('subagent', prepared);
    expect(first.disposition).toBe('existing');

    const claim = JSON.parse(await fs.read(`${TASKS_QUEUES_CLAIMS_DIR}/${prepared.id}.json`));
    expect(claim).toMatchObject({
      schema_version: 1,
      id: prepared.id,
      shortId: prepared.id.slice(0, 8),
      createdAt: prepared.createdAt,
    });
    expect(typeof claim.payloadHash).toBe('string');

    const backfilled = audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_CLAIM_BACKFILLED);
    expect(backfilled).toHaveLength(1);

    const second = await makeSystem().schedulePrepared('subagent', prepared);
    expect(second.disposition).toBe('existing');
    expect(audit.events.filter(e => e[0] === TASK_AUDIT_EVENTS.PREPARED_TASK_CLAIM_BACKFILLED)).toHaveLength(1);
  });
});
