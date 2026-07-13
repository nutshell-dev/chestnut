/**
 * ContractSystem background verification error handling tests
 *
 * phase 1329 split from contract_manager_llm.test.ts (overnight perf optimization)
 * - Extracted L900-1024 background verification error handling describe
 * - Self-contained: no vi.mock for child_process/SubAgent (tests don't trigger spawn path)
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

/**
 * Setup contract files for testing (copy from contract_manager_llm.test.ts)
 */
async function setupContract(
  tempDir: string,
  contractId: string,
  contractYaml: Record<string, unknown>,
  subtaskStatuses: Record<string, string> = {},
): Promise<void> {
  const contractDir = path.join(tempDir, 'contract', 'active', contractId);
  await fs.mkdir(contractDir, { recursive: true });

  // Write contract.yaml
  const yaml = await import('js-yaml');
  await fs.writeFile(path.join(contractDir, 'contract.yaml'), yaml.dump(contractYaml));

  // Write progress.json
  const progress = {
    schema_version: 1,
    contract_id: contractId,
    status: 'running',
    subtasks: (contractYaml.subtasks as any[]).reduce((acc: Record<string, unknown>, st: any) => {
      acc[st.id] = {
        status: subtaskStatuses[st.id] || 'todo',
        retry_count: 0,
      };
      return acc;
    }, {}),
    started_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(contractDir, 'progress.json'), JSON.stringify(progress, null, 2));

  // Create inbox directories
  await fs.mkdir(path.join(tempDir, 'inbox', 'pending'), { recursive: true });
}

describe('ContractSystem — background verification error handling', () => {
  it('catches TypeError in fire-and-forget verification and emits UNEXPECTED_ASYNC_THROW audit', async () => {
    const auditEvents: Array<{ type: string; cols: string[] }> = [];
    const captureAudit = {
      write: (type: string, ...cols: string[]) => { auditEvents.push({ type, cols }); },
    };

    const rootDir = await createTempDir();
    const clawDir = path.join(rootDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
    const mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      llm: mockLLM,
      toolRegistry: createToolRegistry(),
      fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = 'typeerror-test-contract';
    const subtaskId = 'task-1';
    await setupContract(clawDir, contractId, makeContractYaml({
      title: 'TypeError Test',
      goal: 'Test TypeError catch',
      subtasks: [{ id: subtaskId, description: 'Verify TypeError audit' }],
      verification: [{ subtask_id: subtaskId, type: 'llm', prompt_file: `verification/${subtaskId}.prompt.txt` }],
    }), { [subtaskId]: 'todo' });
    await fs.mkdir(path.join(clawDir, 'contract', 'active', contractId, 'verification'), { recursive: true });
    await fs.writeFile(
      path.join(clawDir, 'contract', 'active', contractId, 'verification', `${subtaskId}.prompt.txt`),
      'Evidence: {{evidence}}',
    );

    // Mock loadContractYaml to return malformed YAML (subtasks missing) after setup.
    // This causes TypeError in _runVerificationInBackground when it calls contractYaml.subtasks.find,
    // which bubbles to the .catch block on L545.
    vi.spyOn(manager as any, 'loadContractYaml').mockResolvedValue({
      schema_version: 1,
      title: 'TypeError Test',
      goal: 'Test TypeError catch',
      verification: [{ subtask_id: subtaskId, type: 'llm', prompt_file: `verification/${subtaskId}.prompt.txt` }],
      // subtasks intentionally omitted to trigger TypeError
    });

    await manager.completeSubtask({ contractId, subtaskId, evidence: 'done' });

    await vi.waitUntil(() => auditEvents.some(e => e.type === 'contract_unexpected_async_throw'), { timeout: 5000 });

    expect(auditEvents.some(e => e.type === 'contract_unexpected_async_throw')).toBe(true);
    const throwAudit = auditEvents.find(e => e.type === 'contract_unexpected_async_throw');
    expect(throwAudit?.cols.some(c => c.startsWith('errorType=TypeError'))).toBe(true);
    expect(throwAudit?.cols.some(c => c.startsWith('error='))).toBe(true);

    await manager.close();
    await cleanupTempDir(rootDir);
  });

  it('does NOT emit UNEXPECTED_ASYNC_THROW for business errors in background verification', async () => {
    const auditEvents: Array<{ type: string; cols: string[] }> = [];
    const captureAudit = {
      write: (type: string, ...cols: string[]) => { auditEvents.push({ type, cols }); },
    };

    const rootDir = await createTempDir();
    const clawDir = path.join(rootDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
    const mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      llm: mockLLM,
      toolRegistry: createToolRegistry(),
      fsFactory,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = 'business-error-test-contract';
    const subtaskId = 'task-1';
    await setupContract(clawDir, contractId, makeContractYaml({
      title: 'Business Error Test',
      goal: 'Test business error catch',
      subtasks: [{ id: subtaskId, description: 'Verify business error audit' }],
      verification: [{ subtask_id: subtaskId, type: 'llm', prompt_file: `verification/${subtaskId}.prompt.txt` }],
    }), { [subtaskId]: 'todo' });
    await fs.mkdir(path.join(clawDir, 'contract', 'active', contractId, 'verification'), { recursive: true });
    await fs.writeFile(
      path.join(clawDir, 'contract', 'active', contractId, 'verification', `${subtaskId}.prompt.txt`),
      'Evidence: {{evidence}}',
    );

    // Mock loadContractYaml to return subtasks with a find() that throws plain Error.
    // This causes a business Error in _runVerificationInBackground, which bubbles to .catch
    // but should NOT trigger UNEXPECTED_ASYNC_THROW (only VERIFICATION_RESET_FAILED).
    vi.spyOn(manager as any, 'loadContractYaml').mockResolvedValue({
      schema_version: 1,
      title: 'Business Error Test',
      goal: 'Test business error catch',
      verification: [{ subtask_id: subtaskId, type: 'llm', prompt_file: `verification/${subtaskId}.prompt.txt` }],
      subtasks: {
        find() { throw new Error('LLM rate limit exceeded'); },
      },
    });

    await manager.completeSubtask({ contractId, subtaskId, evidence: 'done' });

    await vi.waitUntil(() => auditEvents.some(e => e.type === 'contract_verification_background_failed'), { timeout: 5000 });

    expect(auditEvents.some(e => e.type === 'contract_unexpected_async_throw')).toBe(false);
    expect(auditEvents.some(e => e.type === 'contract_verification_background_failed')).toBe(true);

    await manager.close();
    await cleanupTempDir(rootDir);
  });
});
