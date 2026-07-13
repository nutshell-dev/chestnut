/**
 * ContractSystem monitor + verification validation tests (phase 1348 split)
 *
 * Extracted from contract_manager.test.ts:549-669 (monitor error reporting + verification validation describes).
 * 6 tests / fast project / no vi.mock for spawn or constants override.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';

let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContractSystem - monitor + verification validation (phase 1348 split)', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-monitor-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');

    vi.clearAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = makeMockAudit();
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  describe('monitor error reporting', () => {
    it('should log error to monitor when loadActive finds corrupted progress.json', async () => {
      const mockAudit = makeMockAudit();
      const monitorManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      // 写入损坏的 progress.json
      const contractId = 'corrupt-contract';
      const contractDir = path.join(clawDir, 'contract', 'active', contractId);
      await fs.mkdir(contractDir, { recursive: true });
      await fs.writeFile(path.join(contractDir, 'progress.json'), '{ invalid json !!');

      const result = await monitorManager.loadActive();
      expect(result).toBeNull(); // 损坏的契约被跳过，返回 null
      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
        expect.stringContaining('context=ContractSystem.loadActive'),
        expect.stringContaining('contractId=corrupt-contract'),
        expect.anything(),
      );
    });

    it('should log error to monitor when loadPaused finds corrupted progress.json', async () => {
      const mockAudit = makeMockAudit();
      const monitorManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = 'corrupt-paused-contract';
      const contractDir = path.join(clawDir, 'contract', 'paused', contractId);
      await fs.mkdir(contractDir, { recursive: true });
      await fs.writeFile(path.join(contractDir, 'progress.json'), '{ bad json ]');

      const result = await monitorManager.loadPaused();
      expect(result).toBeNull();
      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
        expect.stringContaining('context=ContractSystem.loadPaused'),
        expect.stringContaining('contractId=corrupt-paused-contract'),
        expect.stringContaining('error='),
      );
    });

    it('should log warn to monitor when unknown subtaskId is used in completeSubtask', async () => {
      const mockAudit = makeMockAudit();
      const monitorManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await monitorManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 'real-task', description: 'Real task' }],
        verification: [],
      }));

      const result = await monitorManager.completeSubtask({
        contractId,
        subtaskId: 'nonexistent-task',
        evidence: 'evidence',
      });

      expect(result.passed).toBe(false);
      expect(result.feedback).toContain('nonexistent-task');
      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
        expect.stringContaining('context=ContractSystem._completeSubtaskSync'),
        expect.anything(),
        expect.stringContaining('subtaskId=nonexistent-task'),
        expect.stringContaining('message=Unknown subtaskId'),
      );
    });

    it('should clean up contract.yaml if progress.json write fails', async () => {
      // spy writeAtomic，对 progress.json 抛错
      vi.spyOn(nodeFs, 'writeAtomic').mockImplementation(async (p: string, c: string) => {
        if (p.includes('progress.json')) throw new Error('disk full');
        // 其他调用走真实实现
        return fs.writeFile(path.join(clawDir, p), c);
      });

      const mockAudit = makeMockAudit();
      const failManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      await expect(failManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }))).rejects.toThrow('disk full');

      // active/ 下不应存在任何 contract.yaml
      const activeDir = path.join(clawDir, 'contract', 'active');
      const dirs = await fs.readdir(activeDir).catch(() => [] as string[]);
      for (const dir of dirs) {
        const yamlPath = path.join(activeDir, dir, 'contract.yaml');
        await expect(fs.access(yamlPath)).rejects.toThrow(); // ENOENT
      }
    });
  });

  describe('verification validation', () => {
    it('should throw when type is "script" but prompt_file is used', async () => {
      await expect(manager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          // @ts-expect-error - intentionally wrong field for testing
          { subtask_id: 't1', type: 'script', prompt_file: 'verification/t1.prompt.txt' },
        ],
      }))).rejects.toThrow('script_file');
    });

    it('should throw when type is "llm" but script_file is used', async () => {
      await expect(manager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          // @ts-expect-error - intentionally wrong field for testing
          { subtask_id: 't1', type: 'llm', script_file: 'verification/t1.sh' },
        ],
      }))).rejects.toThrow('prompt_file');
    });
  });

});
