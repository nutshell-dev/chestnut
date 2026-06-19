/**
 * No-verification path tests
 *
 * Verifies that when a contract has NO `verification` field, submitting a subtask
 * immediately marks it as completed (skipping the verification background pipeline).
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
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

/**
 * Mock 慢 verification 延迟 (150ms): 保 subtask 留 in_progress 长到同步断言完成.
 * Derivation: > 同步断言总 budget / 给 mock LLM call 真延迟而非 instant resolve.
 */
const MOCK_SLOW_VERIFICATION_MS = 150;

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-no-verification-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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

describe('no verification path', () => {
  it('submit with no verification → immediately completed', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(
      makeContractYaml({
        verification: undefined,
      }),
    );

    const result = await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    // Assert subtask status is completed immediately
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['task-1'].status).toBe('completed');

    // Assert result indicates completion
    expect(result.passed).toBe(true);
    expect(result.allCompleted).toBe(true);

    // Assert subtask_completed audit event was emitted
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED);
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED)).toBe(true);

    // Assert verification_started was NOT emitted (indirectly proves background
    // verification pipeline was skipped)
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED)).toBe(false);
  });

  it('submit with verification → goes to background path', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(
      makeContractYaml({
        verification: [
          {
            subtask_id: 'task-1',
            type: 'llm',
            prompt_file: 'verification/task-1.prompt.txt',
          },
        ],
      }),
    );

    // Create prompt file directory and file so the background verifier can find it
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
    await fs.writeFile(
      path.join(contractDir, 'verification', 'task-1.prompt.txt'),
      'Test prompt',
      'utf-8',
    );

    // Mock runLLMVerification to delay, keeping the subtask in_progress for the
    // duration of this test so assertions are deterministic.
    vi.spyOn(manager as any, 'runLLMVerification').mockImplementation(async () => {
      // sleep: keep subtask in_progress long enough for synchronous assertions above
      await new Promise((r) => setTimeout(r, MOCK_SLOW_VERIFICATION_MS));
      return { passed: true, feedback: 'mocked' };
    });

    const result = await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    // Assert subtask status is in_progress — NOT completed immediately
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['task-1'].status).toBe('in_progress');

    // Assert result indicates async background verification
    expect(result.async).toBe(true);
    expect(result.passed).toBe(false);

    // Assert verification_started audit event was emitted
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED);
    expect(events.some((e) => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED)).toBe(true);
  });

  it('submit with no verification notifies caller', async () => {
    const { audit } = makeAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(
      makeContractYaml({
        verification: undefined,
      }),
    );

    const notifyCalls: Array<{ type: string; data: Record<string, unknown> }> = [];
    manager.setOnNotify((type, data) => {
      notifyCalls.push({ type, data });
    });

    await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    // Assert onNotify was called with subtask_completed
    const subtaskCompletedCalls = notifyCalls.filter((c) => c.type === 'subtask_completed');
    expect(subtaskCompletedCalls.length).toBeGreaterThanOrEqual(1);
    expect(subtaskCompletedCalls[0].data).toMatchObject({
      contractId,
      subtaskId: 'task-1',
    });
  });
});
