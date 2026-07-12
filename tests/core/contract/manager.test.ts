/**
 * ContractSystem manager tests (phase 956)
 *
 * - contractDir multi-directory detection
 * - create uniqueness across active/paused/archive
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { ContractValidationError } from '../../../src/core/contract/errors.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-contract-manager-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

function setupManager() {
  const { audit, events, emitter } = makeAudit();
  const manager = new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),
  });
  return { manager, audit, events, emitter };
}

describe('ContractSystem manager (phase 956)', () => {
  it('throws when contract exists in multiple directories', async () => {
    const { manager, events, emitter } = setupManager();
    const contractId = 'multi-dir-c1';

    // Create progress.json in both active and paused directories
    await fs.mkdir(path.join(clawDir, 'contract', 'active', contractId), { recursive: true });
    await fs.mkdir(path.join(clawDir, 'contract', 'paused', contractId), { recursive: true });
    const progress = {
      schema_version: 1,
      subtasks: { 'task-1': { status: 'todo' } },
      started_at: new Date().toISOString(),
      checkpoint: null,
    };
    await fs.writeFile(
      path.join(clawDir, 'contract', 'active', contractId, 'progress.json'),
      JSON.stringify(progress),
      'utf-8',
    );
    await fs.writeFile(
      path.join(clawDir, 'contract', 'paused', contractId, 'progress.json'),
      JSON.stringify(progress),
      'utf-8',
    );

    await expect(manager.getProgress(contractId)).rejects.toThrow(/multiple directories/);
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.CONTRACT_MULTI_DIR);
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_MULTI_DIR)).toBe(true);
  });

  it('rejects create when contractId already exists in active', async () => {
    const manager = setupManager().manager;
    const contractId = 'dup-active-c1';

    // Simulate an existing active contract directory
    await fs.mkdir(path.join(clawDir, 'contract', 'active', contractId), { recursive: true });

    await expect(
      manager.create(makeContractYaml({ id: contractId })),
    ).rejects.toThrow(ContractValidationError);

    try {
      await manager.create(makeContractYaml({ id: contractId }));
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.field).toBe('id');
      expect(e.kind).toBe('already_exists');
      expect(e.context?.contractId).toBe(contractId);
      expect(e.message).toContain('active');
    }
  });

  it('rejects create when contractId already exists in paused', async () => {
    const manager = setupManager().manager;
    const contractId = 'dup-paused-c1';

    await fs.mkdir(path.join(clawDir, 'contract', 'paused', contractId), { recursive: true });

    await expect(
      manager.create(makeContractYaml({ id: contractId })),
    ).rejects.toThrow(ContractValidationError);
  });
});
