/**
 * Contract system tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';
import { promises as fs } from 'fs';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

async function createContract(
  tempDir: string,
  contractId: string,
  status: 'running' | 'paused' | 'completed' = 'running'
): Promise<void> {
  // ContractSystem 现在使用 active/paused/archive 子目录
  const subDir = status === 'completed' ? 'archive' : status === 'paused' ? 'paused' : 'active';
  const contractDir = path.join(tempDir, 'contract', subDir, contractId);
  await fs.mkdir(contractDir, { recursive: true });

  // Create contract.yaml
  const yamlContent = `schema_version: 1
id: ${contractId}
title: "Test Contract"
goal: "Test goal"
subtasks:
  - id: st-001
    description: "Subtask 1"
  - id: st-002
    description: "Subtask 2"
verification:
  - subtask_id: st-001
    type: script
    script_file: "echo 'test'"
auth_level: notify
`;
  await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

  // Create progress.json
  // phase 319: schema_version: 1 required by Zod SoT strict (mirror phase 311 pattern)
  const progress = {
    schema_version: 1,
    contract_id: contractId,
    status,
    subtasks: {
      'st-001': { status: 'todo' },
      'st-002': { status: 'todo' },
    },
    started_at: new Date().toISOString(),
    checkpoint: null,
  };
  await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress, null, 2));
}

describe('Contract System', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let mockAudit: { write: ReturnType<typeof vi.fn> };
  let auditEmitter: EventEmitter;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    auditEmitter = new EventEmitter();
    mockAudit = {
      write: vi.fn((type: string, ...cols: string[]) => {
        auditEmitter.emit('write', type, ...cols);
      }),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    };
  });

  afterEach(async () => {
    // Drain any pending background verification before cleanup (phase 779 Step A / B.flaky-4)
    const pendingAcceptances = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED,
    );
    const doneCount = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    ).length;
    if (pendingAcceptances.length > doneCount) {
      const needed = pendingAcceptances.length - doneCount;
      let received = 0;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          auditEmitter.off('write', handler);
          reject(new Error(`timeout waiting for ${needed} verification_done events`));
        }, 3000);
        const handler = (ev: string) => {
          if (ev === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE) {
            received++;
            if (received >= needed) {
              clearTimeout(timer);
              auditEmitter.off('write', handler);
              resolve();
            }
          }
        };
        auditEmitter.on('write', handler);
      });
    }
    await cleanupTempDir(tempDir);
  });

  describe('ContractSystem', () => {

    it('should load active contract with running status', async () => {
      await createContract(tempDir, 'contract-001', 'running');

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const active = await manager.loadActive();

      expect(active?.id).toBe('contract-001');
      expect(active?.title).toBe('Test Contract');
    });

    it('should return null when no active contract', async () => {
      // No contract created
      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const active = await manager.loadActive();

      expect(active).toBeNull();
    });

    it('should return null when all contracts are completed', async () => {
      await createContract(tempDir, 'contract-001', 'completed');

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const active = await manager.loadActive();

      expect(active).toBeNull();
    });

    it('should get contract progress', async () => {
      await createContract(tempDir, 'contract-001', 'running');

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const progress = await manager.getProgress('contract-001');

      expect(progress.contract_id).toBe('contract-001');
      expect(progress.status).toBe('running');
      expect(progress.subtasks['st-001']).toMatchObject({ status: 'todo' });
    });

    it('should complete subtask without verification (auto-pass)', async () => {
      // Create contract without verification config for st-001
      const contractDir = path.join(tempDir, 'contract', 'active', 'contract-002');
      await fs.mkdir(contractDir, { recursive: true });

      const yamlContent = `schema_version: 1
id: contract-002
title: "No Acceptance"
goal: "Test"
subtasks:
  - id: st-001
    description: "Subtask without verification"
auth_level: auto
`;
      await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

      const progress = {
        schema_version: 1,
        contract_id: 'contract-002',
        status: 'running',
        subtasks: { 'st-001': { status: 'todo' } },
        started_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress));

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const result = await manager.completeSubtask({
        contractId: 'contract-002',
        subtaskId: 'st-001',
        evidence: 'Done',
      });

      expect(result.passed).toBe(true);
      
      const updatedProgress = await manager.getProgress('contract-002');
      expect(updatedProgress.subtasks['st-001'].status).toBe('completed');
    });

    it('should complete subtask with script verification (success)', async () => {
      // Use a command that always succeeds
      const contractDir = path.join(tempDir, 'contract', 'active', 'contract-003');
      await fs.mkdir(contractDir, { recursive: true });

      const yamlContent = `schema_version: 1
id: contract-003
title: "Script Acceptance"
goal: "Test"
subtasks:
  - id: st-001
    description: "Subtask with script"
verification:
  - subtask_id: st-001
    type: script
    script_file: "verification/st-001.sh"
auth_level: auto
`;
      await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

      const progress = {
        schema_version: 1,
        contract_id: 'contract-003',
        status: 'running',
        subtasks: { 'st-001': { status: 'todo' } },
        started_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress));

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const result = await manager.completeSubtask({
        contractId: 'contract-003',
        subtaskId: 'st-001',
        evidence: 'Done',
      });

      // Async verification: returns { async: true, passed: false } immediately
      expect(result.async).toBe(true);
      // Actual result will arrive via inbox notification
    });

    it('should fail subtask with script verification (command fails)', async () => {
      const contractDir = path.join(tempDir, 'contract', 'active', 'contract-004');
      await fs.mkdir(contractDir, { recursive: true });

      const yamlContent = `schema_version: 1
id: contract-004
title: "Failing Script"
goal: "Test"
subtasks:
  - id: st-001
    description: "Subtask with failing script"
verification:
  - subtask_id: st-001
    type: script
    script_file: "verification/st-001.sh"
auth_level: auto
`;
      await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

      const progress = {
        schema_version: 1,
        contract_id: 'contract-004',
        status: 'running',
        subtasks: { 'st-001': { status: 'todo' } },
        started_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress));

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const result = await manager.completeSubtask({
        contractId: 'contract-004',
        subtaskId: 'st-001',
        evidence: 'Done',
      });

      expect(result.passed).toBe(false);
    });

    it('should check if all subtasks are completed', async () => {
      const contractDir = path.join(tempDir, 'contract', 'active', 'contract-005');
      await fs.mkdir(contractDir, { recursive: true });

      const yamlContent = `schema_version: 1
id: contract-005
title: "Complete Check"
goal: "Test"
subtasks:
  - id: st-001
    description: "Subtask 1"
  - id: st-002
    description: "Subtask 2"
auth_level: auto
`;
      await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

      // Both pending
      const progress = {
        schema_version: 1,
        contract_id: 'contract-005',
        status: 'running',
        subtasks: {
          'st-001': { status: 'todo' },
          'st-002': { status: 'todo' },
        },
        started_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress));

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      expect(await manager.isComplete('contract-005')).toBe(false);

      // Complete one
      await manager.completeSubtask({
        contractId: 'contract-005',
        subtaskId: 'st-001',
        evidence: 'Done',
      });
      expect(await manager.isComplete('contract-005')).toBe(false);

      // Complete the other
      await manager.completeSubtask({
        contractId: 'contract-005',
        subtaskId: 'st-002',
        evidence: 'Done',
      });
      expect(await manager.isComplete('contract-005')).toBe(true);
    });

    it('should pause contract', async () => {
      await createContract(tempDir, 'contract-006', 'running');

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      await manager.pause('contract-006', 'Checkpoint note');

      const progress = await manager.getProgress('contract-006');
      expect(progress.status).toBe('paused');
      expect(progress.checkpoint).toBe('Checkpoint note');
    });

    it('should resume contract', async () => {
      await createContract(tempDir, 'contract-007', 'paused');

      // Set checkpoint
      const progressPath = path.join(tempDir, 'contract', 'paused', 'contract-007', 'progress.json');
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      progress.checkpoint = 'Saved state';
      await fs.writeFile(progressPath, JSON.stringify(progress));

      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const resumed = await manager.resume('contract-007');

      expect(resumed.status).toBe('running');
      
      const updatedProgress = await manager.getProgress('contract-007');
      expect(updatedProgress.checkpoint).toBeNull();
    });

    it('writes CONTRACT_PROGRESS_CORRUPTED audit when loadActive finds corrupted progress.json', async () => {
      const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
      const auditManager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = 'corrupt-audit-contract';
      const contractDir = path.join(tempDir, 'contract', 'active', contractId);
      await fs.mkdir(contractDir, { recursive: true });
      await fs.writeFile(path.join(contractDir, 'progress.json'), '{ broken json');

      const result = await auditManager.loadActive();
      expect(result).toBeNull();

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
        expect.stringContaining('file='),
        expect.stringContaining('error='),
      );
    });
  });
});
