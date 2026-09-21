import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import {
  type EnsureRetrospectiveInput,
} from '../../../src/core/evolution-system/index.js';
import { RetrospectiveStore, READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR } from '../../../src/core/evolution-system/retrospective-store.js';
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
