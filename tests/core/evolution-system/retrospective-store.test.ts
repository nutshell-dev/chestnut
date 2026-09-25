import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import {
  type EnsureRetrospectiveInput,
} from '../../../src/core/evolution-system/index.js';
import { RetrospectiveStore, READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR, CLAIMS_DIR } from '../../../src/core/evolution-system/retrospective-store.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { makeContractId, type ContractId } from '../../../src/core/contract/types.js';
import { makeFullTaskId, type FullTaskId } from '../../../src/core/async-task-system/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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

function makeInput(overrides?: Partial<EnsureRetrospectiveInput>): EnsureRetrospectiveInput {
  return {
    contractId: makeContractId(`contract-${randomUUID().slice(0, 8)}`),
    targetExecutorId: 'claw-a',
    ...overrides,
  };
}

describe('RetrospectiveStore (Phase 1206 Step B)', () => {
  let baseDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let store: RetrospectiveStore;
  let taskIdSeq: number;

  beforeEach(async () => {
    baseDir = await createTempDir('retro-store-');
    mkdirSync(baseDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir });
    audit = makeAudit();
    taskIdSeq = 0;
    store = new RetrospectiveStore({
      fs,
      audit: audit.audit,
      generateTaskId: () => makeFullTaskId(`00000000-0000-0000-0000-${String(taskIdSeq++).padStart(12, '0')}`),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(baseDir);
  });

  it('ensure writes a v2 ready row (identity only) and returns stable task_id', async () => {
    const input = makeInput();
    const result = await store.ensure(input);
    expect(result.taskId).toBeTruthy();
    expect(result.createdAt).toBeTruthy();

    const readyPath = path.join(baseDir, `${READY_DIR}/${input.contractId}.json`);
    expect(existsSync(readyPath)).toBe(true);

    // Phase 1396 Step M: 新 writer 只保存 contract/executor/task identity
    const onDisk = JSON.parse(await fs.read(`${READY_DIR}/${input.contractId}.json`));
    expect(onDisk).toMatchObject({
      schema_version: 2,
      contract_id: input.contractId,
      target_executor_id: input.targetExecutorId,
    });
    expect(onDisk).not.toHaveProperty('target_claw');
    expect(onDisk).not.toHaveProperty('mode');
    expect(onDisk).not.toHaveProperty('mining_task_id');
    expect(onDisk).not.toHaveProperty('shadow_task_id');

    const committedEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED);
    expect(committedEvents).toHaveLength(1);
  });

  it('v1 legacy row is strictly readable and matches ensure by (contractId, executor)', async () => {
    // Phase 1396 Step M: v1 只读兼容 —— 不重写、按 (contract_id, target_claw) 幂等匹配。
    const input = makeInput();
    await fs.ensureDir(READY_DIR);
    const legacyTaskId = '00000000-0000-0000-0000-0000000000aa';
    await fs.writeAtomic(
      `${READY_DIR}/${input.contractId}.json`,
      JSON.stringify({
        schema_version: 1,
        contract_id: input.contractId,
        task_id: legacyTaskId,
        target_claw: input.targetExecutorId,
        created_at: '2026-01-01T00:00:00.000Z',
        mode: 'shadow',
        shadow_task_id: 'legacy-source-task',
      }),
    );

    const ready = await store.listReady();
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      schema_version: 1,
      contract_id: input.contractId,
      target_claw: input.targetExecutorId,
      mode: 'shadow',
      shadow_task_id: 'legacy-source-task',
    });

    const again = await store.ensure(input);
    expect(again.taskId).toBe(legacyTaskId);

    const conflict = store.ensure({ ...input, targetExecutorId: 'claw-b' });
    await expect(conflict).rejects.toThrow(/registration conflict/);
  });

  it('ensure is idempotent for identical input', async () => {
    const input = makeInput();
    const first = await store.ensure(input);
    const second = await store.ensure(input);
    expect(second.taskId).toBe(first.taskId);
    expect(second.createdAt).toBe(first.createdAt);

    const readyFiles = await fs.list(READY_DIR, { includeDirs: false });
    expect(readyFiles).toHaveLength(1);
  });

  it('ensure rejects mismatched re-registration', async () => {
    const input = makeInput();
    await store.ensure(input);
    await expect(store.ensure({ ...input, targetExecutorId: 'claw-b' })).rejects.toThrow(/registration conflict/);

    const conflictEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_REGISTRATION_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('beginDispatch acquires ready row', async () => {
    const input = makeInput();
    await store.ensure(input);

    const disposition = await store.beginDispatch(input.contractId);
    expect(disposition).toBe('acquired');

    expect(existsSync(path.join(baseDir, `${READY_DIR}/${input.contractId}.json`))).toBe(false);
    expect(existsSync(path.join(baseDir, `${DISPATCHING_DIR}/${input.contractId}.json`))).toBe(true);
  });

  it('beginDispatch returns submitted if row already submitted', async () => {
    const input = makeInput();
    await store.ensure(input);
    await store.beginDispatch(input.contractId);
    const row = await store.readDispatching(input.contractId);
    expect(row).toBeTruthy();
    await store.markSubmitted(input.contractId);

    const disposition = await store.beginDispatch(input.contractId);
    expect(disposition).toBe('submitted');
  });

  it('beginDispatch returns busy if row is dispatching', async () => {
    const input = makeInput();
    await store.ensure(input);
    await store.beginDispatch(input.contractId);

    const disposition = await store.beginDispatch(input.contractId);
    expect(disposition).toBe('busy');
  });

  it('beginDispatch returns missing for unknown contract', async () => {
    const disposition = await store.beginDispatch(makeContractId('unknown'));
    expect(disposition).toBe('missing');
  });

  it('markSubmitted moves dispatching to submitted', async () => {
    const input = makeInput();
    await store.ensure(input);
    await store.beginDispatch(input.contractId);
    await store.markSubmitted(input.contractId);

    expect(existsSync(path.join(baseDir, `${DISPATCHING_DIR}/${input.contractId}.json`))).toBe(false);
    expect(existsSync(path.join(baseDir, `${SUBMITTED_DIR}/${input.contractId}.json`))).toBe(true);

    const submittedRow = await store.readSubmitted(input.contractId);
    expect(submittedRow).toBeTruthy();
    expect(submittedRow!.contract_id).toBe(input.contractId);
  });

  it('concurrent beginDispatch only one acquires', async () => {
    const input = makeInput();
    await store.ensure(input);

    const results = await Promise.all([
      store.beginDispatch(input.contractId),
      store.beginDispatch(input.contractId),
      store.beginDispatch(input.contractId),
    ]);

    const acquiredCount = results.filter(r => r === 'acquired').length;
    expect(acquiredCount).toBe(1);

    const dispatchingFiles = await fs.list(DISPATCHING_DIR, { includeDirs: false });
    expect(dispatchingFiles).toHaveLength(1);
  });

  it('lists rows sorted by created_at then contract_id', async () => {
    const inputA = makeInput({ contractId: makeContractId('contract-a') });
    const inputB = makeInput({ contractId: makeContractId('contract-b') });
    const inputC = makeInput({ contractId: makeContractId('contract-c') });

    await store.ensure(inputB);
    await store.ensure(inputA);
    await store.ensure(inputC);

    const ready = await store.listReady();
    // Rows are sorted by created_at ascending; contract-b was registered first.
    expect(ready.map(r => r.contract_id)).toEqual([inputB.contractId, inputA.contractId, inputC.contractId]);
  });

  it('corrupt row is preserved and audited but not returned', async () => {
    const contractId = makeContractId('corrupt');
    await fs.ensureDir(READY_DIR);
    await fs.writeAtomic(`${READY_DIR}/${contractId}.json`, 'not-json');

    const list = await store.listReady();
    expect(list).toHaveLength(0);

    const corruptEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT);
    expect(corruptEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('future-version row is preserved and audited but not returned', async () => {
    const contractId = makeContractId('future');
    await fs.ensureDir(READY_DIR);
    await fs.writeAtomic(
      `${READY_DIR}/${contractId}.json`,
      JSON.stringify({ schema_version: 99, contract_id: contractId, task_id: 'x', target_claw: 'a', created_at: '2026-01-01' }),
    );

    const list = await store.listReady();
    expect(list).toHaveLength(0);

    const futureEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_FUTURE_VERSION);
    expect(futureEvents).toHaveLength(1);
  });

  it('multi-state row fails ensure and beginDispatch', async () => {
    const input = makeInput();
    await fs.ensureDir(READY_DIR);
    await fs.ensureDir(DISPATCHING_DIR);
    await fs.writeAtomic(`${READY_DIR}/${input.contractId}.json`, JSON.stringify({ schema_version: 1, contract_id: input.contractId, task_id: '00000000-0000-0000-0000-000000000000', target_claw: input.targetExecutorId, created_at: '2026-01-01' }));
    await fs.writeAtomic(`${DISPATCHING_DIR}/${input.contractId}.json`, JSON.stringify({ schema_version: 1, contract_id: input.contractId, task_id: '00000000-0000-0000-0000-000000000001', target_claw: input.targetExecutorId, created_at: '2026-01-01' }));

    await expect(store.ensure(input)).rejects.toThrow(/multiple states/);
    await expect(store.beginDispatch(input.contractId)).rejects.toThrow(/multiple states/);

    const multiStateEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_MULTI_STATE);
    expect(multiStateEvents).toHaveLength(2);
  });

});

describe('RetrospectiveStore.ensure concurrency (Phase 1902 Step C)', () => {
  let baseDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let store: RetrospectiveStore;
  let taskIdSeq: number;

  beforeEach(async () => {
    baseDir = await createTempDir('retro-store-race-');
    mkdirSync(baseDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir });
    audit = makeAudit();
    taskIdSeq = 0;
    store = new RetrospectiveStore({
      fs,
      audit: audit.audit,
      generateTaskId: () => makeFullTaskId(`00000000-0000-0000-0000-${String(taskIdSeq++).padStart(12, '0')}`),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(baseDir);
  });

  function makeRaceStore(taskIdSeed: number): RetrospectiveStore {
    return new RetrospectiveStore({
      fs,
      audit: audit.audit,
      generateTaskId: () => makeFullTaskId(`00000000-0000-0000-0000-${String(taskIdSeed).padStart(12, '0')}`),
    });
  }

  it('concurrent ensure with identical input commits exactly one row and one task identity', async () => {
    const input = makeInput();
    const stores = Array.from({ length: 5 }, (_, i) => makeRaceStore(i + 1));

    const results = await Promise.all(stores.map(s => s.ensure(input)));

    const taskIds = new Set(results.map(r => r.taskId));
    expect(taskIds.size).toBe(1);
    const createdAts = new Set(results.map(r => r.createdAt));
    expect(createdAts.size).toBe(1);

    const readyFiles = await fs.list(READY_DIR, { includeDirs: false });
    expect(readyFiles).toHaveLength(1);

    const committedEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED);
    expect(committedEvents).toHaveLength(1);
  });

  it('concurrent ensure with different executors yields exactly one winner and one conflict', async () => {
    const contractId = makeContractId('contract-race');
    const storeA = makeRaceStore(1);
    const storeB = makeRaceStore(2);

    const settled = await Promise.allSettled([
      storeA.ensure({ contractId, targetExecutorId: 'claw-a' }),
      storeB.ensure({ contractId, targetExecutorId: 'claw-b' }),
    ]);

    const fulfilled = settled.filter(r => r.status === 'fulfilled');
    const rejected = settled.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/registration conflict/);

    const readyFiles = await fs.list(READY_DIR, { includeDirs: false });
    expect(readyFiles).toHaveLength(1);

    const committedEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED);
    expect(committedEvents).toHaveLength(1);
  });

  it('replays winner identity when the winner claims and is dispatched while the loser is mid-scan (Phase 1904 barrier)', async () => {
    const input = makeInput();
    const winnerTaskId = makeFullTaskId('00000000-0000-0000-0000-0000000000aa');
    const winnerClaim = JSON.stringify({
      schema_version: 1,
      contract_id: input.contractId,
      task_id: winnerTaskId,
      target_executor_id: input.targetExecutorId,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const winnerRow = JSON.stringify({
      schema_version: 2,
      contract_id: input.contractId,
      task_id: winnerTaskId,
      target_executor_id: input.targetExecutorId,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    // 屏障：L 初扫三态为空后，W 建 claim、写 ready row 并 move 到 dispatching
    // （RACE-RETRO-LIFECYCLE-CLAIM 的原交错）；随后 L 的 claim O_EXCL 真实失败。
    class WinnerClaimedAndMovedFs extends NodeFileSystem {
      private barrierArmed = true;
      override async writeExclusive(p: string, content: string): Promise<void> {
        if (this.barrierArmed && p.startsWith(CLAIMS_DIR)) {
          this.barrierArmed = false;
          await super.writeAtomic(p, winnerClaim);
          const winnerReadyPath = p.replace(CLAIMS_DIR, READY_DIR);
          await super.writeAtomic(winnerReadyPath, winnerRow);
          await super.move(winnerReadyPath, winnerReadyPath.replace(READY_DIR, DISPATCHING_DIR));
        }
        return super.writeExclusive(p, content);
      }
    }

    const raceStore = new RetrospectiveStore({ fs: new WinnerClaimedAndMovedFs({ baseDir }), audit: audit.audit });
    const result = await raceStore.ensure(input);

    // L 必须 replay W 的身份，不得生成第二 task/row
    expect(result.taskId).toBe(winnerTaskId);
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(existsSync(path.join(baseDir, `${READY_DIR}/${input.contractId}.json`))).toBe(false);
    expect(existsSync(path.join(baseDir, `${DISPATCHING_DIR}/${input.contractId}.json`))).toBe(true);

    const claimFiles = await fs.list(CLAIMS_DIR, { includeDirs: false });
    expect(claimFiles).toHaveLength(1);

    const committedEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED);
    expect(committedEvents).toHaveLength(0);
  });

  it('fails closed with indeterminate when ready-row EEXIST conflicts after claim but no row ever becomes readable', async () => {
    const input = makeInput();

    class PhantomConflictFs extends NodeFileSystem {
      override async writeExclusive(p: string, content: string): Promise<void> {
        if (p.startsWith(READY_DIR)) {
          const err = new Error('file already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return super.writeExclusive(p, content);
      }
    }

    const raceStore = new RetrospectiveStore({ fs: new PhantomConflictFs({ baseDir }), audit: audit.audit });
    await expect(raceStore.ensure(input)).rejects.toThrow(/indeterminate/);

    // 不静默生成新 task：任何状态目录都没有该 contract 的 row
    for (const dir of [READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR]) {
      expect(existsSync(path.join(baseDir, `${dir}/${input.contractId}.json`))).toBe(false);
    }

    const readFailed = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED);
    expect(readFailed.some(e => e.includes('reason=ensure_identity_indeterminate'))).toBe(true);
  });

  it('rebuilds the ready row from a committed claim after a crash window (claim exists, no row)', async () => {
    const input = makeInput();
    const claimTaskId = makeFullTaskId('00000000-0000-0000-0000-0000000000cc');
    await fs.ensureDir(CLAIMS_DIR);
    await fs.writeAtomic(`${CLAIMS_DIR}/${input.contractId}.json`, JSON.stringify({
      schema_version: 1,
      contract_id: input.contractId,
      task_id: claimTaskId,
      target_executor_id: input.targetExecutorId,
      created_at: '2026-02-02T00:00:00.000Z',
    }));

    // 崩溃窗口：claim 已提交、row 从未发布 —— 不得生成新 task id
    const raceStore = new RetrospectiveStore({
      fs,
      audit: audit.audit,
      generateTaskId: () => makeFullTaskId('00000000-0000-0000-0000-0000000000ff'),
    });
    const result = await raceStore.ensure(input);

    expect(result.taskId).toBe(claimTaskId);
    expect(result.createdAt).toBe('2026-02-02T00:00:00.000Z');

    const onDisk = JSON.parse(await fs.read(`${READY_DIR}/${input.contractId}.json`));
    expect(onDisk).toMatchObject({
      schema_version: 2,
      contract_id: input.contractId,
      task_id: claimTaskId,
      target_executor_id: input.targetExecutorId,
    });

    const rebuiltEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_CLAIM_ROW_REBUILT);
    expect(rebuiltEvents).toHaveLength(1);
    const committedEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED);
    expect(committedEvents).toHaveLength(0);

    // 重建后重试幂等：同 task id，不再重建、不再 committed
    const again = await raceStore.ensure(input);
    expect(again.taskId).toBe(claimTaskId);
    expect(audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_CLAIM_ROW_REBUILT)).toHaveLength(1);
  });

  it('fails closed on a durably corrupt claim without creating any row', async () => {
    const input = makeInput();
    await fs.ensureDir(CLAIMS_DIR);
    await fs.writeAtomic(`${CLAIMS_DIR}/${input.contractId}.json`, 'not-json');

    await expect(store.ensure(input)).rejects.toThrow(/indeterminate/);

    for (const dir of [READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR]) {
      expect(existsSync(path.join(baseDir, `${dir}/${input.contractId}.json`))).toBe(false);
    }

    const readFailed = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED);
    expect(readFailed.some(e => e.includes('reason=ensure_claim_indeterminate'))).toBe(true);
  });

  it('tolerates a half-written claim that completes during the reread window', async () => {
    const input = makeInput();
    const claimTaskId = makeFullTaskId('00000000-0000-0000-0000-0000000000dd');
    await fs.ensureDir(CLAIMS_DIR);
    // writeExclusive 先发布路径再完成内容写：首次读到空串，重读得到完整内容
    await fs.writeAtomic(`${CLAIMS_DIR}/${input.contractId}.json`, JSON.stringify({
      schema_version: 1,
      contract_id: input.contractId,
      task_id: claimTaskId,
      target_executor_id: input.targetExecutorId,
      created_at: '2026-03-03T00:00:00.000Z',
    }));

    class PartialClaimFs extends NodeFileSystem {
      private servedPartial = false;
      override async read(p: string): Promise<string> {
        if (!this.servedPartial && p.startsWith(CLAIMS_DIR)) {
          this.servedPartial = true;
          return '';
        }
        return super.read(p);
      }
    }

    const raceStore = new RetrospectiveStore({ fs: new PartialClaimFs({ baseDir }), audit: audit.audit });
    const result = await raceStore.ensure(input);

    // claim 匹配但 row 缺失 → 以 claim 身份重建，不生成新 task id
    expect(result.taskId).toBe(claimTaskId);
    const rebuiltEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_CLAIM_ROW_REBUILT);
    expect(rebuiltEvents).toHaveLength(1);
  });

  it('backfills a stable claim once for a legacy row and replays afterwards', async () => {
    const input = makeInput();
    const legacyTaskId = makeFullTaskId('00000000-0000-0000-0000-0000000000bb');
    await fs.ensureDir(DISPATCHING_DIR);
    await fs.writeAtomic(`${DISPATCHING_DIR}/${input.contractId}.json`, JSON.stringify({
      schema_version: 2,
      contract_id: input.contractId,
      task_id: legacyTaskId,
      target_executor_id: input.targetExecutorId,
      created_at: '2026-01-15T00:00:00.000Z',
    }));

    const first = await store.ensure(input);
    expect(first.taskId).toBe(legacyTaskId);

    // 旧 row 一次性迁移：claim 以 row 身份补建
    const claim = JSON.parse(await fs.read(`${CLAIMS_DIR}/${input.contractId}.json`));
    expect(claim).toMatchObject({
      schema_version: 1,
      contract_id: input.contractId,
      task_id: legacyTaskId,
      target_executor_id: input.targetExecutorId,
    });
    const backfilled = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_CLAIM_BACKFILLED);
    expect(backfilled).toHaveLength(1);

    // 再次调用只 replay，不重复补建
    const second = await store.ensure(input);
    expect(second.taskId).toBe(legacyTaskId);
    expect(audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_CLAIM_BACKFILLED)).toHaveLength(1);
  });

  it('fails closed when claim and row identities disagree', async () => {
    const input = makeInput();
    await fs.ensureDir(CLAIMS_DIR);
    await fs.ensureDir(READY_DIR);
    await fs.writeAtomic(`${CLAIMS_DIR}/${input.contractId}.json`, JSON.stringify({
      schema_version: 1,
      contract_id: input.contractId,
      task_id: '00000000-0000-0000-0000-000000000011',
      target_executor_id: input.targetExecutorId,
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    await fs.writeAtomic(`${READY_DIR}/${input.contractId}.json`, JSON.stringify({
      schema_version: 2,
      contract_id: input.contractId,
      task_id: '00000000-0000-0000-0000-000000000022',
      target_executor_id: input.targetExecutorId,
      created_at: '2026-01-01T00:00:00.000Z',
    }));

    await expect(store.ensure(input)).rejects.toThrow(/claim\/row identity mismatch/);

    const conflicts = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_REGISTRATION_CONFLICT);
    expect(conflicts.some(e => e.includes('reason=claim_row_identity_mismatch'))).toBe(true);
  });

  it('fails closed with indeterminate when claim EEXIST conflicts but the claim never becomes readable', async () => {
    const input = makeInput();

    class PhantomClaimFs extends NodeFileSystem {
      override async writeExclusive(p: string, content: string): Promise<void> {
        if (p.startsWith(CLAIMS_DIR)) {
          const err = new Error('file already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
        return super.writeExclusive(p, content);
      }
    }

    const raceStore = new RetrospectiveStore({ fs: new PhantomClaimFs({ baseDir }), audit: audit.audit });
    await expect(raceStore.ensure(input)).rejects.toThrow(/indeterminate/);

    for (const dir of [READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR]) {
      expect(existsSync(path.join(baseDir, `${dir}/${input.contractId}.json`))).toBe(false);
    }

    const readFailed = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED);
    expect(readFailed.some(e => e.includes('reason=ensure_claim_indeterminate'))).toBe(true);
  });

  it('replays the same task identity after the row reaches submitted', async () => {
    const input = makeInput();
    const first = await store.ensure(input);
    await store.beginDispatch(input.contractId);
    await store.markSubmitted(input.contractId);

    const again = await store.ensure(input);
    expect(again.taskId).toBe(first.taskId);
    expect(again.createdAt).toBe(first.createdAt);

    const committedEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED);
    expect(committedEvents).toHaveLength(1);
  });

});
