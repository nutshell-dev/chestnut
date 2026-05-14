/**
 * Contract system tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

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
deliverables:
  - "Deliverable 1"
subtasks:
  - id: st-001
    description: "Subtask 1"
  - id: st-002
    description: "Subtask 2"
acceptance:
  - subtask_id: st-001
    type: script
    command: "echo 'test'"
auth_level: notify
`;
  await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

  // Create progress.json
  const progress = {
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
    };
  });

  afterEach(async () => {
    // Drain any pending background acceptance before cleanup (phase 779 Step A / B.flaky-4)
    const pendingAcceptances = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.ACCEPTANCE_STARTED,
    );
    const doneCount = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.ACCEPTANCE_BACKGROUND_DONE,
    ).length;
    if (pendingAcceptances.length > doneCount) {
      const needed = pendingAcceptances.length - doneCount;
      let received = 0;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          auditEmitter.off('write', handler);
          reject(new Error(`timeout waiting for ${needed} acceptance_done events`));
        }, 3000);
        const handler = (ev: string) => {
          if (ev === CONTRACT_AUDIT_EVENTS.ACCEPTANCE_BACKGROUND_DONE) {
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

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
      const active = await manager.loadActive();

      expect(active).toBeDefined();
      expect(active?.id).toBe('contract-001');
      expect(active?.title).toBe('Test Contract');
    });

    it('should return null when no active contract', async () => {
      // No contract created
      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
      const active = await manager.loadActive();

      expect(active).toBeNull();
    });

    it('should return null when all contracts are completed', async () => {
      await createContract(tempDir, 'contract-001', 'completed');

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
      const active = await manager.loadActive();

      expect(active).toBeNull();
    });

    it('should get contract progress', async () => {
      await createContract(tempDir, 'contract-001', 'running');

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
      const progress = await manager.getProgress('contract-001');

      expect(progress.contract_id).toBe('contract-001');
      expect(progress.status).toBe('running');
      expect(progress.subtasks['st-001']).toBeDefined();
    });

    it('should complete subtask without acceptance (auto-pass)', async () => {
      // Create contract without acceptance config for st-001
      const contractDir = path.join(tempDir, 'contract', 'active', 'contract-002');
      await fs.mkdir(contractDir, { recursive: true });

      const yamlContent = `schema_version: 1
id: contract-002
title: "No Acceptance"
goal: "Test"
deliverables: []
subtasks:
  - id: st-001
    description: "Subtask without acceptance"
auth_level: auto
`;
      await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

      const progress = {
        contract_id: 'contract-002',
        status: 'running',
        subtasks: { 'st-001': { status: 'todo' } },
        started_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress));

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
      const result = await manager.completeSubtask({
        contractId: 'contract-002',
        subtaskId: 'st-001',
        evidence: 'Done',
      });

      expect(result.passed).toBe(true);
      
      const updatedProgress = await manager.getProgress('contract-002');
      expect(updatedProgress.subtasks['st-001'].status).toBe('completed');
    });

    it('should complete subtask with script acceptance (success)', async () => {
      // Use a command that always succeeds
      const contractDir = path.join(tempDir, 'contract', 'active', 'contract-003');
      await fs.mkdir(contractDir, { recursive: true });

      const yamlContent = `schema_version: 1
id: contract-003
title: "Script Acceptance"
goal: "Test"
deliverables: []
subtasks:
  - id: st-001
    description: "Subtask with script"
acceptance:
  - subtask_id: st-001
    type: script
    script_file: "acceptance/st-001.sh"
auth_level: auto
`;
      await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

      const progress = {
        contract_id: 'contract-003',
        status: 'running',
        subtasks: { 'st-001': { status: 'todo' } },
        started_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress));

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
      const result = await manager.completeSubtask({
        contractId: 'contract-003',
        subtaskId: 'st-001',
        evidence: 'Done',
      });

      // Async acceptance: returns { async: true, passed: false } immediately
      expect(result.async).toBe(true);
      // Actual result will arrive via inbox notification
    });

    it('should fail subtask with script acceptance (command fails)', async () => {
      const contractDir = path.join(tempDir, 'contract', 'active', 'contract-004');
      await fs.mkdir(contractDir, { recursive: true });

      const yamlContent = `schema_version: 1
id: contract-004
title: "Failing Script"
goal: "Test"
deliverables: []
subtasks:
  - id: st-001
    description: "Subtask with failing script"
acceptance:
  - subtask_id: st-001
    type: script
    script_file: "acceptance/st-001.sh"
auth_level: auto
`;
      await fs.writeFile(path.join(contractDir, 'contract.yaml'), yamlContent);

      const progress = {
        contract_id: 'contract-004',
        status: 'running',
        subtasks: { 'st-001': { status: 'todo' } },
        started_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress));

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
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
deliverables: []
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
        contract_id: 'contract-005',
        status: 'running',
        subtasks: {
          'st-001': { status: 'todo' },
          'st-002': { status: 'todo' },
        },
        started_at: new Date().toISOString(),
      };
      await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress));

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
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

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
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

      const manager = new ContractSystem(tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry());
      const resumed = await manager.resume('contract-007');

      expect(resumed.status).toBe('running');
      
      const updatedProgress = await manager.getProgress('contract-007');
      expect(updatedProgress.checkpoint).toBeNull();
    });

    it('writes CONTRACT_PROGRESS_CORRUPTED audit when loadActive finds corrupted progress.json', async () => {
      const mockAudit = { write: vi.fn() };
      const auditManager = new ContractSystem(
        tempDir, 'test-claw', mockFs, mockAudit as any, undefined, createToolRegistry()
      );

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
