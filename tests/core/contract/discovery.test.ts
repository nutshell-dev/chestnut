/**
 * Contract discovery tests (phase 956)
 *
 * - loadAllActiveContracts returns all active contracts and audits when multiple found
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { loadAllActiveContracts, loadActiveContract } from '../../../src/core/contract/discovery.js';
import { MultipleActiveContractsError } from '../../../src/core/contract/errors.js';
import { makeAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

let tmpDir: string;
let clawDir: string;
let activeDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-contract-discovery-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  activeDir = path.join(clawDir, 'contract', 'active');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(activeDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

async function writeContractDir(contractId: string, startedAt: string) {
  const dir = path.join(activeDir, contractId);
  await fs.mkdir(dir, { recursive: true });
  const progress = {
    schema_version: 1,
    subtasks: { 'task-1': { status: 'todo' } },
    started_at: startedAt,
    checkpoint: null,
  };
  await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify(progress), 'utf-8');
}

describe('Contract discovery (phase 956)', () => {
  it('returns all active contracts and audits when multiple found', async () => {
    const { audit, events, emitter } = makeAudit();
    const ctx = {
      fs: nodeFs,
      audit,
      loadContract: vi.fn(async (id: string) => ({ id } as any)),
    };

    await writeContractDir('c1', '2026-07-12T10:00:00.000Z');
    await writeContractDir('c2', '2026-07-12T11:00:00.000Z');

    const all = await loadAllActiveContracts(ctx, 'contract/active');

    expect(all.length).toBe(2);
    expect(all.map((e) => e.name).sort()).toEqual(['c1', 'c2']);

    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS);
    const event = events.find((e) => e[0] === CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS);
    expect(event).toBeDefined();
    expect(event!.some((col) => typeof col === 'string' && col.startsWith('count=2'))).toBe(true);
    expect(event!.some((col) => typeof col === 'string' && col.includes('c1') && col.includes('c2'))).toBe(true);
  });

  it('returns single active contract without multi-active audit', async () => {
    const { audit, events } = makeAudit();
    const ctx = {
      fs: nodeFs,
      audit,
      loadContract: vi.fn(async (id: string) => ({ id } as any)),
    };

    await writeContractDir('c1', '2026-07-12T10:00:00.000Z');

    const all = await loadAllActiveContracts(ctx, 'contract/active');

    expect(all.length).toBe(1);
    expect(all[0].name).toBe('c1');
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS)).toBe(false);
  });

  it('throws MultipleActiveContractsError when multiple valid active contracts exist', async () => {
    const { audit, events, emitter } = makeAudit();
    const ctx = {
      fs: nodeFs,
      audit,
      loadContract: vi.fn(async (id: string) => ({ id } as any)),
    };

    await writeContractDir('c1', '2026-07-12T10:00:00.000Z');
    await writeContractDir('c2', '2026-07-12T11:00:00.000Z');

    await expect(loadActiveContract(ctx, 'contract/active')).rejects.toThrow(MultipleActiveContractsError);
    await expect(loadActiveContract(ctx, 'contract/active')).rejects.toThrow(/Found 2 active contracts/);

    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS);
    const event = events.find((e) => e[0] === CONTRACT_AUDIT_EVENTS.MULTI_ACTIVE_CONTRACTS);
    expect(event).toBeDefined();
    expect(event!.some((col) => typeof col === 'string' && col.startsWith('count=2'))).toBe(true);
  });
});
