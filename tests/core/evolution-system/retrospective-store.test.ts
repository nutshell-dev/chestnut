import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import {
  RetrospectiveStore,
  type RegisterRetrospectiveInput,
} from '../../../src/core/evolution-system/index.js';
import { READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR } from '../../../src/core/evolution-system/retrospective-store.js';
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

function makeInput(overrides?: Partial<RegisterRetrospectiveInput>): RegisterRetrospectiveInput {
  return {
    contractId: makeContractId(`contract-${randomUUID().slice(0, 8)}`),
    targetClaw: 'claw-a',
    mode: 'shadow',
    shadowTaskId: `task-${randomUUID().slice(0, 8)}`,
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

  it('register writes a ready row and returns stable task_id', async () => {
    const input = makeInput();
    const result = await store.register(input);
    expect(result.taskId).toBeTruthy();
    expect(result.createdAt).toBeTruthy();

    const readyPath = path.join(baseDir, `${READY_DIR}/${input.contractId}.json`);
    expect(existsSync(readyPath)).toBe(true);

    const committedEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED);
    expect(committedEvents).toHaveLength(1);
  });

  it('register is idempotent for identical input', async () => {
    const input = makeInput();
    const first = await store.register(input);
    const second = await store.register(input);
    expect(second.taskId).toBe(first.taskId);
    expect(second.createdAt).toBe(first.createdAt);

    const readyFiles = await fs.list(READY_DIR, { includeDirs: false });
    expect(readyFiles).toHaveLength(1);
  });

  it('register rejects mismatched re-registration', async () => {
    const input = makeInput();
    await store.register(input);
    await expect(store.register({ ...input, targetClaw: 'claw-b' })).rejects.toThrow(/registration conflict/);

    const conflictEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_REGISTRATION_CONFLICT);
    expect(conflictEvents).toHaveLength(1);
  });

  it('beginDispatch acquires ready row', async () => {
    const input = makeInput();
    await store.register(input);

    const disposition = await store.beginDispatch(input.contractId);
    expect(disposition).toBe('acquired');

    expect(existsSync(path.join(baseDir, `${READY_DIR}/${input.contractId}.json`))).toBe(false);
    expect(existsSync(path.join(baseDir, `${DISPATCHING_DIR}/${input.contractId}.json`))).toBe(true);
  });

  it('beginDispatch returns submitted if row already submitted', async () => {
    const input = makeInput();
    await store.register(input);
    await store.beginDispatch(input.contractId);
    const row = await store.readDispatching(input.contractId);
    expect(row).toBeTruthy();
    await store.markSubmitted(input.contractId);

    const disposition = await store.beginDispatch(input.contractId);
    expect(disposition).toBe('submitted');
  });

  it('beginDispatch returns busy if row is dispatching', async () => {
    const input = makeInput();
    await store.register(input);
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
    await store.register(input);
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
    await store.register(input);

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

    await store.register(inputB);
    await store.register(inputA);
    await store.register(inputC);

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

  it('multi-state row fails register and beginDispatch', async () => {
    const input = makeInput();
    await fs.ensureDir(READY_DIR);
    await fs.ensureDir(DISPATCHING_DIR);
    await fs.writeAtomic(`${READY_DIR}/${input.contractId}.json`, JSON.stringify({ schema_version: 1, contract_id: input.contractId, task_id: '00000000-0000-0000-0000-000000000000', target_claw: input.targetClaw, created_at: '2026-01-01' }));
    await fs.writeAtomic(`${DISPATCHING_DIR}/${input.contractId}.json`, JSON.stringify({ schema_version: 1, contract_id: input.contractId, task_id: '00000000-0000-0000-0000-000000000001', target_claw: input.targetClaw, created_at: '2026-01-01' }));

    await expect(store.register(input)).rejects.toThrow(/multiple states/);
    await expect(store.beginDispatch(input.contractId)).rejects.toThrow(/multiple states/);

    const multiStateEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_STORE_MULTI_STATE);
    expect(multiStateEvents).toHaveLength(2);
  });

  it('migrates legacy rows and acks them', async () => {
    const legacyRows = [
      { contractId: makeContractId('legacy-1'), targetClaw: 'claw-1', mode: 'shadow' as const, shadowTaskId: 's1' },
      { contractId: makeContractId('legacy-2'), targetClaw: 'claw-2', mode: 'mining' as const, miningTaskId: 'm1' },
    ];
    const acked = new Set<string>();

    const result = await store.migrateLegacyRows(
      async () => legacyRows,
      async (contractId) => { acked.add(contractId); },
    );

    expect(result.migrated).toBe(2);
    expect(result.failed).toBe(0);
    expect(acked.size).toBe(2);

    const ready = await store.listReady();
    expect(ready).toHaveLength(2);
  });

  it('migration failure preserves legacy row and audits', async () => {
    const input = makeInput();
    const legacyRows = [{ ...input, createdAt: '2026-01-01' }];

    const result = await store.migrateLegacyRows(
      async () => legacyRows,
      async () => { throw new Error('ack failed'); },
    );

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);

    const failedEvents = audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_LEGACY_MIGRATION_FAILED);
    expect(failedEvents).toHaveLength(1);
  });

  it('migration skips already-consistent rows and acks them', async () => {
    const input = makeInput();
    await store.register(input);

    const acked = new Set<string>();
    const result = await store.migrateLegacyRows(
      async () => [{ ...input, createdAt: '2026-01-01' }],
      async (contractId) => { acked.add(contractId); },
    );

    expect(result.migrated).toBe(1);
    expect(acked.has(input.contractId)).toBe(true);
  });
});
