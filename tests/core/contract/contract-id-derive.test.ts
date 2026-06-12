/**
 * Phase 282 Step B: contract_id derive from caller/dir
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

describe('contract_id derive (phase 282 Step B)', () => {
  let tmpDir: string;
  let clawDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `.test-phase282-b-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('loadProgress returns ProgressData with contract_id from caller', async () => {
    const mockAudit = makeMockAudit();
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const progress = await manager.getProgress(contractId);
    expect(progress).not.toBeNull();
    expect(progress!.contract_id).toBe(contractId);
  });

  it('legacy contract_id field in JSON → migration emit + ignored', async () => {
    const mockAudit = makeMockAudit();
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // overwrite with legacy contract_id field
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(progressPath, JSON.stringify({
      schema_version: 1,
      contract_id: 'legacy-id',
      subtasks: { t1: { status: 'todo' } },
    }), 'utf-8');

    const progress = await manager.getProgress(contractId);
    expect(progress).not.toBeNull();
    // contract_id derived from caller, legacy value ignored
    expect(progress!.contract_id).toBe(contractId);

    const legacyCalls = (mockAudit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_CONTRACT_ID_FIELD_IGNORED,
    );
    expect(legacyCalls.length).toBeGreaterThanOrEqual(1);
    expect(legacyCalls[0]).toContainEqual(expect.stringContaining('legacy_contract_id=legacy-id'));
  });

  it('saveProgress does not write contract_id field', async () => {
    const mockAudit = makeMockAudit();
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    const saved = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
    expect(saved).not.toHaveProperty('contract_id');
  });
});
