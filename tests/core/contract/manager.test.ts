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
import { makeAudit, makeMockAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { ContractValidationError } from '../../../src/core/contract/errors.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

  it('resets in_progress subtasks during boot reconcile (Phase 966)', async () => {
    const { manager, events } = setupManager();
    const contractId = 'boot-reconcile-in-progress';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });

    const yaml = await import('js-yaml');
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      yaml.dump(makeContractYaml({ id: contractId })),
    );
    await fs.writeFile(
      path.join(contractDir, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        status: 'running',
        subtasks: {
          'task-1': { status: 'in_progress', verification_attempt_id: 'old-attempt' },
        },
        started_at: new Date().toISOString(),
        checkpoint: null,
      }, null, 2),
    );

    await manager.init();

    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['task-1'].status).toBe('todo');
    expect(progress.subtasks['task-1'].verification_attempt_id).toBeUndefined();
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET)).toBe(true);
  });

  it('continues to next contract when one fails in boot reconcile (Phase 968)', async () => {
    const { manager, events } = setupManager();
    const c1 = 'boot-reconcile-isolate-c1';
    const c2 = 'boot-reconcile-isolate-c2';
    const c1Dir = path.join(clawDir, 'contract', 'active', c1);
    const c2Dir = path.join(clawDir, 'contract', 'active', c2);
    await fs.mkdir(c1Dir, { recursive: true });
    await fs.mkdir(c2Dir, { recursive: true });

    const yaml = await import('js-yaml');
    const baseProgress = {
      schema_version: 1,
      status: 'running',
      subtasks: {
        'task-1': { status: 'in_progress', verification_attempt_id: 'old-attempt' },
      },
      started_at: new Date().toISOString(),
      checkpoint: null,
    };

    await fs.writeFile(path.join(c1Dir, 'contract.yaml'), yaml.dump(makeContractYaml({ id: c1 })));
    await fs.writeFile(path.join(c1Dir, 'progress.json'), JSON.stringify({ ...baseProgress, contract_id: c1 }, null, 2));
    await fs.writeFile(path.join(c2Dir, 'contract.yaml'), yaml.dump(makeContractYaml({ id: c2 })));
    await fs.writeFile(path.join(c2Dir, 'progress.json'), JSON.stringify({ ...baseProgress, contract_id: c2 }, null, 2));

    vi.spyOn(manager, 'getProgress')
      .mockResolvedValueOnce({
        schema_version: 1,
        contract_id: c1,
        status: 'running',
        subtasks: { 'task-1': { status: 'in_progress', verification_attempt_id: 'old-attempt' } },
        started_at: new Date().toISOString(),
      } as any)
      .mockRejectedValueOnce(new Error('EIO'));

    await manager.init();

    const c1Progress = await manager.getProgress(c1);
    expect(c1Progress.subtasks['task-1'].status).toBe('todo');
    expect(c1Progress.subtasks['task-1'].verification_attempt_id).toBeUndefined();
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET)).toBe(true);
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET_FAILED)).toBe(true);
  });

  it('does not register controller when audit fails (Phase 968)', () => {
    const audit = makeMockAudit();
    audit.write = vi.fn((type: string, ..._cols: (string | number)[]) => {
      if (type === CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED) {
        throw new Error('audit fail');
      }
    }) as unknown as typeof audit.write;
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: audit as unknown as Parameters<typeof ContractSystem>[0]['audit'],
      toolRegistry: createToolRegistry(),
      fsFactory,
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });

    const ctrl = new AbortController();
    expect(() => (manager as any)._registerVerifierController('c1', ctrl, Promise.resolve())).toThrow('audit fail');
    expect((manager as any)._activeContractControllers.has('c1')).toBe(false);
  });
});
