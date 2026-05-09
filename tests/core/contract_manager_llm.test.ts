/**
 * ContractSystem LLM/Script acceptance integration tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

// State to control spawn mock behavior
let execFileMockBehavior: 'success' | 'fail' | 'timeout' = 'success';
let execFileMockError: any = null;
let execFileMockStdout = '';
let execFileMockStderr = '';

// Mock child_process BEFORE importing ContractSystem
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: any) => {
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn(() => {
        proc.emit('close', null, 'SIGTERM');
      });

      setImmediate(() => {
        if (execFileMockBehavior === 'success') {
          if (execFileMockStdout) {
            proc.stdout.emit('data', Buffer.from(execFileMockStdout));
          }
          if (execFileMockStderr) {
            proc.stderr.emit('data', Buffer.from(execFileMockStderr));
          }
          proc.emit('close', 0, null);
        } else if (execFileMockBehavior === 'fail') {
          if (execFileMockStdout) {
            proc.stdout.emit('data', Buffer.from(execFileMockStdout));
          }
          if (execFileMockStderr) {
            proc.stderr.emit('data', Buffer.from(execFileMockStderr));
          }
          proc.emit('close', 1, null);
        } else if (execFileMockBehavior === 'timeout') {
          proc.emit('close', null, 'SIGTERM');
        }
      });

      return proc;
    }),
  };
});

// Mock SubAgent
const mockSubAgentRun = vi.fn();
let capturedSubAgentRegistry: import('../../src/foundation/tools/registry.js').ToolRegistryImpl | null = null;
let capturedOnIdleTimeout: (() => void) | null = null;
vi.mock('../../src/core/subagent/agent.js', () => ({
  SubAgent: vi.fn().mockImplementation((opts: any) => {
    capturedSubAgentRegistry = opts.registry ?? null;
    capturedOnIdleTimeout = opts.onIdleTimeout ?? null;
    return { run: mockSubAgentRun };
  }),
}));

// Now import the modules under test
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { InboxWriter } from '../../src/foundation/messaging/index.js';

import { DEFAULT_MAX_STEPS } from '../../src/constants.js';

/**
 * Setup contract files for testing
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

/**
 * Read all inbox messages from claw inbox
 */
async function readClawInbox(tempDir: string): Promise<Array<{ filename: string; content: string }>> {
  const inboxDir = path.join(tempDir, 'inbox', 'pending');
  try {
    const files = await fs.readdir(inboxDir);
    const messages = [];
    for (const filename of files.filter(f => f.endsWith('.md'))) {
      const content = await fs.readFile(path.join(inboxDir, filename), 'utf-8');
      messages.push({ filename, content });
    }
    return messages.sort((a, b) => a.filename.localeCompare(b.filename));
  } catch {
    return [];
  }
}

/**
 * Read all inbox messages from motion inbox
 */
async function readMotionInbox(tempDir: string): Promise<Array<{ filename: string; content: string }>> {
  // motion inbox is at ../../motion/inbox/pending relative to clawDir (tempDir)
  const motionInboxDir = path.resolve(tempDir, '..', '..', 'motion', 'inbox', 'pending');
  try {
    const files = await fs.readdir(motionInboxDir);
    const messages = [];
    for (const filename of files.filter(f => f.endsWith('.md'))) {
      const content = await fs.readFile(path.join(motionInboxDir, filename), 'utf-8');
      messages.push({ filename, content });
    }
    return messages.sort((a, b) => a.filename.localeCompare(b.filename));
  } catch {
    return [];
  }
}

/**
 * Wait for background acceptance to complete by polling inbox for new files.
 * All acceptance paths (pass/reject/error) write an inbox message as their final step.
 */
async function waitForAcceptance(
  tempDir: string,
  expectedCount = 1,
  timeoutMs = 5000,
): Promise<void> {
  const inboxDir = path.join(tempDir, 'inbox', 'pending');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const files = await fs.readdir(inboxDir);
      if (files.filter(f => f.endsWith('.md')).length >= expectedCount) return;
    } catch {}
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitForAcceptance timed out after ${timeoutMs}ms`);
}

describe('ContractSystem Acceptance Flow', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let mockAudit: { write: ReturnType<typeof vi.fn> };
  let mockLLM: LLMOrchestrator;
  // mockRegistry removed — ToolRegistryImpl internalized in VerifierScheduler (phase364)

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedSubAgentRegistry = null;
    capturedOnIdleTimeout = null;
    
    // Reset execFile mock state
    execFileMockBehavior = 'success';
    execFileMockError = null;
    execFileMockStdout = '';
    execFileMockStderr = '';
    
    // Create proper directory structure: /tmp/<root>/claws/test-claw/
    // so that ../../motion resolves to /tmp/<root>/motion/
    const rootDir = await createTempDir();
    clawDir = path.join(rootDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    tempDir = clawDir;  // 保持后续代码兼容

    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const logsDir = path.join(clawDir, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    mockAudit = { write: vi.fn() };

    mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;

    manager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, mockLLM);
  });

  afterEach(async () => {
    vi.useRealTimers();
    // 清理 rootDir（clawDir 的祖父目录）
    await cleanupTempDir(path.resolve(clawDir, '..', '..'));
  });

  describe('Script Acceptance', () => {
    it('should reject path traversal attack in script_file', async () => {
      const contractId = 'test-contract-1';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'script', script_file: '../../../etc/passwd' }],
      });

      const result = await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      expect(result.async).toBe(true);
      await waitForAcceptance(tempDir);

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('acceptance_rejection'));
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].content).toContain('路径安全');
    });

    it('should pass when script acceptance succeeds', async () => {
      const contractId = 'test-contract-2';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'script', script_file: 'acceptance/task-1.sh' }],
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(path.join(acceptanceDir, 'task-1.sh'), '#!/bin/bash\necho "ok"', { mode: 0o755 });

      // Set execFile mock to succeed
      execFileMockBehavior = 'success';
      execFileMockStdout = 'ok';

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      // Wait for archive (moveToArchive is the last step after inbox write)
      const archiveProgressPath = path.join(tempDir, 'contract', 'archive', contractId, 'progress.json');
      const activeProgressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const dl = Date.now() + 5000;
      let progress: any;
      while (Date.now() < dl) {
        try {
          progress = JSON.parse(await fs.readFile(archiveProgressPath, 'utf-8'));
          break;
        } catch {
          try {
            const p = JSON.parse(await fs.readFile(activeProgressPath, 'utf-8'));
            if (p.subtasks['task-1'].status === 'completed') { progress = p; break; }
          } catch {}
        }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(progress.subtasks['task-1'].status).toBe('completed');

      const inbox = await readClawInbox(tempDir);
      const results = inbox.filter(m => m.content.includes('acceptance_result'));
      expect(results.length).toBeGreaterThan(0);
    });

    it('should fail and increment retry_count when script acceptance fails', async () => {
      const contractId = 'test-contract-3';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'script', script_file: 'acceptance/task-1.sh' }],
        escalation: { max_retries: 3 },
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(path.join(acceptanceDir, 'task-1.sh'), '#!/bin/bash\necho "fail"\nexit 1', { mode: 0o755 });

      // Set execFile mock to fail
      execFileMockBehavior = 'fail';
      execFileMockStderr = 'test error output';

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      await waitForAcceptance(tempDir);

      const progressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      expect(progress.subtasks['task-1'].retry_count).toBe(1);
      expect(progress.subtasks['task-1'].status).toBe('todo');

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('acceptance_rejection'));
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].content).toContain('test error output');
    });

    it('should return rejection when script acceptance config has no script_file', async () => {
      const contractId = 'test-script-no-file';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        // type: 'script' 但故意缺 script_file
        acceptance: [{ subtask_id: 'task-1', type: 'script' }],
      });

      const result = await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });
      expect(result.async).toBe(true);
      await waitForAcceptance(tempDir);

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('acceptance_rejection'));
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].content).toContain('缺少 script_file');
    });

    it('should log warn to monitor when script acceptance config has no script_file', async () => {
      const logSpy = vi.spyOn(mockAudit, 'write');
      const contractId = 'test-script-no-file-monitor';
      await setupContract(tempDir, contractId, {
        schema_version: 1, title: 'Test', goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'script' }], // 故意缺 script_file
      });

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'e' });
      await waitForAcceptance(tempDir);

      expect(logSpy).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
        expect.stringContaining('context=ContractSystem.runAcceptanceByType'),
        expect.anything(),
      );
    });
  });

  describe('LLM Acceptance', () => {
    it('should pass when LLM acceptance returns passed=true', async () => {
      const contractId = 'test-contract-4';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(path.join(acceptanceDir, 'task-1.prompt.txt'), 'Check if {{evidence}} is valid');

      mockSubAgentRun.mockResolvedValue('{"passed":true,"reason":"looks good","issues":[]}');

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      // Wait for inbox message (last sync step; 其他 it 统一用 waitForAcceptance)
      // 不要 poll progress.json —— saveProgress resolve 与 _writeAcceptanceInbox 之间
      // 有 microtask yield 窗口，在并发跑负载下会 flake（测试侧先看到 completed 后再读 inbox 时 inbox 仍空）
      await waitForAcceptance(tempDir);

      // inbox 写完后 progress 必已落地（同步或已 resolve）；读哪条路径都行
      const archiveProgressPath = path.join(tempDir, 'contract', 'archive', contractId, 'progress.json');
      const activeProgressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      let progress: any;
      try {
        progress = JSON.parse(await fs.readFile(archiveProgressPath, 'utf-8'));
      } catch {
        progress = JSON.parse(await fs.readFile(activeProgressPath, 'utf-8'));
      }
      expect(progress.subtasks['task-1'].status).toBe('completed');

      const inbox = await readClawInbox(tempDir);
      const results = inbox.filter(m => m.content.includes('acceptance_result'));
      expect(results.length).toBeGreaterThan(0);
    });

    it('should fail and format rejection when LLM returns passed=false', async () => {
      const contractId = 'test-contract-5';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task implementation' }],
        acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
        escalation: { max_retries: 3 },
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(path.join(acceptanceDir, 'task-1.prompt.txt'), 'Check if {{evidence}} is valid');

      mockSubAgentRun.mockResolvedValue(
        '{"passed":false,"reason":"缺少测试","issues":["add unit tests", "add integration tests"]}'
      );

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      await waitForAcceptance(tempDir);

      const progressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      expect(progress.subtasks['task-1'].retry_count).toBe(1);

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('acceptance_rejection'));
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].content).toContain('缺少测试');
    });

    it('should reject path traversal in prompt_file', async () => {
      const contractId = 'test-contract-6';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: '../../../etc/passwd' }],
      });

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      await waitForAcceptance(tempDir);

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('acceptance_rejection'));
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].content).toContain('路径安全');
    });

    it('should return rejection when llm acceptance config has no prompt_file', async () => {
      const contractId = 'test-llm-no-file';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        // type: 'llm' 但故意缺 prompt_file
        acceptance: [{ subtask_id: 'task-1', type: 'llm' }],
      });

      const result = await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });
      expect(result.async).toBe(true);
      await waitForAcceptance(tempDir);

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('acceptance_rejection'));
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].content).toContain('缺少 prompt_file');
    });

    it('should return rejection when LLM is not injected in ContractSystem', async () => {
      const contractId = 'test-llm-not-injected';
      // manager without llm
      const nodeFs = new NodeFileSystem({ baseDir: clawDir });
      const noLLMManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any);

      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
      });

      const result = await noLLMManager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });
      expect(result.async).toBe(true);
      await waitForAcceptance(tempDir);

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('acceptance_rejection'));
      expect(rejections.length).toBeGreaterThan(0);
      expect(rejections[0].content).toContain('LLM 验收未配置');
    });

    it('should log warn to monitor when llm acceptance config has no prompt_file', async () => {
      const logSpy = vi.spyOn(mockAudit, 'write');
      const contractId = 'test-llm-no-prompt-monitor';
      await setupContract(tempDir, contractId, {
        schema_version: 1, title: 'Test', goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'llm' }], // 故意缺 prompt_file
      });

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'e' });
      await waitForAcceptance(tempDir);

      expect(logSpy).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
        expect.stringContaining('context=ContractSystem.runAcceptanceByType'),
        expect.anything(),
      );
    });

    it('should prefer capturedResult over text when report_result tool is called', async () => {
      const contractId = 'test-llm-captured';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(
        path.join(acceptanceDir, 'task-1.prompt.txt'),
        'Check if {{evidence}} is valid. {{artifacts}}'
      );

      // SubAgent.run() 调用 report_result 工具后返回任意文字（应被忽略）
      mockSubAgentRun.mockImplementation(async () => {
        // 模拟 LLM 在 run() 内部调用了 report_result 工具
        if (capturedSubAgentRegistry) {
          const reportTool = capturedSubAgentRegistry.get('report_result');
          if (reportTool) {
            await reportTool.execute(
              { passed: true, reason: 'all checks passed via tool' },
              {} as any
            );
          }
        }
        return 'irrelevant text that is not JSON'; // 文本不含 JSON，但应被忽略
      });

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });

      // Wait for archive (moveToArchive is the last step after inbox write)
      const archiveProgressPath = path.join(tempDir, 'contract', 'archive', contractId, 'progress.json');
      const activeProgressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const dl = Date.now() + 5000;
      let progress: any;
      while (Date.now() < dl) {
        try {
          progress = JSON.parse(await fs.readFile(archiveProgressPath, 'utf-8'));
          break;
        } catch {
          try {
            const p = JSON.parse(await fs.readFile(activeProgressPath, 'utf-8'));
            if (p.subtasks['task-1'].status === 'completed') { progress = p; break; }
          } catch {}
        }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(progress.subtasks['task-1'].status).toBe('completed');

      const inbox = await readClawInbox(tempDir);
      expect(inbox.filter(m => m.content.includes('acceptance_result'))).toHaveLength(1);
    });

    it('should return rejection with "无法解析 JSON" when LLM text has no JSON', async () => {
      const contractId = 'test-llm-no-json';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
        escalation: { max_retries: 3 },
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(
        path.join(acceptanceDir, 'task-1.prompt.txt'),
        'Check if {{evidence}} is valid. {{artifacts}}'
      );

      // SubAgent 未调用 report_result，返回纯文字（无 JSON）
      mockSubAgentRun.mockResolvedValue('I reviewed the evidence but cannot determine a verdict.');

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptance(tempDir);

      // 应以 rejected 写入 inbox，内容含 "无法解析 JSON"
      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('acceptance_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('无法解析 JSON');

      // subtask 应重置为 todo，retry_count = 1
      const progressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      expect(progress.subtasks['task-1'].status).toBe('todo');
      expect(progress.subtasks['task-1'].retry_count).toBe(1);
    });

    it('should notify Motion with acceptance_timeout when onIdleTimeout is triggered', async () => {
      const contractId = 'test-llm-timeout';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(
        path.join(acceptanceDir, 'task-1.prompt.txt'),
        'Check if {{evidence}} is valid. {{artifacts}}'
      );

      // SubAgent.run() 在执行中途触发 idle timeout 回调，然后返回空文字
      mockSubAgentRun.mockImplementation(async () => {
        capturedOnIdleTimeout?.();
        return '{}'; // 返回合法 JSON 确保主流程继续（避免额外 rejection 干扰）
      });

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptance(tempDir);

      // auditWriter 应收到 acceptance_timeout 日志
      const auditWriter = (manager as any).audit;
      const timeoutCalls = auditWriter.write.mock.calls.filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.ACCEPTANCE_TIMEOUT);
      expect(timeoutCalls).toHaveLength(1);
      expect(timeoutCalls[0][1]).toContain('task-1');
    });
  });

  describe('Escalation', () => {
    it('should write escalation audit when retry_count reaches max_retries', async () => {
      const contractId = 'test-contract-7';
      // Setup contract with max_retries=2
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'script', script_file: 'acceptance/task-1.sh' }],
        escalation: { max_retries: 2 },
      }, { 'task-1': 'todo' });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(path.join(acceptanceDir, 'task-1.sh'), '#!/bin/bash\nexit 1', { mode: 0o755 });

      // Pre-set retry_count to 1 (simulating one previous failure)
      // This means this failure will push it to 2, triggering escalation
      const progressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const initialProgress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      initialProgress.subtasks['task-1'].retry_count = 1;
      await fs.writeFile(progressPath, JSON.stringify(initialProgress, null, 2));

      // Set execFile to fail
      execFileMockBehavior = 'fail';
      execFileMockStderr = 'test failure';

      // This failure should push retry_count to 2, triggering escalation audit
      const auditWriter = (manager as any).audit;
      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'attempt 2',
      });

      // Escalation audit is written after inbox, so wait for the audit call
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (auditWriter.write.mock.calls.some((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.ESCALATED)) break;
        await new Promise(r => setTimeout(r, 10));
      }

      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      expect(progress.subtasks['task-1'].retry_count).toBe(2);

      const escalationCalls = auditWriter.write.mock.calls.filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.ESCALATED);
      expect(escalationCalls.length).toBeGreaterThan(0);
      expect(escalationCalls[0][1]).toContain('task-1');
    });
  });

  describe('phase230 audit events', () => {
    it('writes CONTRACT_ACCEPTANCE_SCRIPT_STARTED audit when running script acceptance', async () => {
      const contractId = 'test-script-audit';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'script', script_file: 'acceptance/task-1.sh' }],
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(path.join(acceptanceDir, 'task-1.sh'), '#!/bin/bash\necho "ok"', { mode: 0o755 });

      execFileMockBehavior = 'success';

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptance(tempDir);

      const auditWriter = (manager as any).audit;
      expect(auditWriter.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_SCRIPT_STARTED,
        expect.stringContaining('script='),
        expect.stringContaining('cwd='),
      );
    });

    it('writes CONTRACT_ACCEPTANCE_INBOX_FAILED when inbox write fails', async () => {
      const writeSyncSpy = vi.spyOn(InboxWriter.prototype, 'writeSync').mockImplementation(() => {
        throw new Error('inbox full');
      });

      try {
        // @ts-expect-error - private method
        await manager._writeAcceptanceError('contract-1', 'task-1', new Error('acceptance crashed'));

        const auditWriter = (manager as any).audit;
        expect(auditWriter.write).toHaveBeenCalledWith(
          CONTRACT_AUDIT_EVENTS.ACCEPTANCE_INBOX_FAILED,
          expect.stringContaining('context=ContractSystem._writeAcceptanceError'),
          expect.stringContaining('inbox full'),
        );
      } finally {
        writeSyncSpy.mockRestore();
      }
    });

    it('writes CONTRACT_ACCEPTANCE_RESET_FAILED when reset status fails', async () => {
      const lockSpy = vi.spyOn(manager as any, 'withProgressLock').mockRejectedValue(new Error('lock busy'));

      try {
        // @ts-expect-error - private method
        await manager._writeAcceptanceError('contract-1', 'task-1', new Error('acceptance crashed'));

        const auditWriter = (manager as any).audit;
        expect(auditWriter.write).toHaveBeenCalledWith(
          CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
          expect.stringContaining('context=ContractSystem._writeAcceptanceError.resetStatus'),
          expect.stringContaining('lock busy'),
        );
      } finally {
        lockSpy.mockRestore();
      }
    });
  });

  describe('Acceptance Inbox Message Format', () => {
    it('should write passed message with correct frontmatter and normal priority', async () => {
      const contractId = 'test-inbox-passed';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'script', script_file: 'acceptance/task-1.sh' }],
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(path.join(acceptanceDir, 'task-1.sh'), '#!/bin/bash\nexit 0', { mode: 0o755 });

      execFileMockBehavior = 'success';

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptance(tempDir);

      const inbox = await readClawInbox(tempDir);
      expect(inbox).toHaveLength(1);

      const { filename, content } = inbox[0];
      // 文件名含 _normal_
      expect(filename).toContain('_normal_');

      // 核心字段
      expect(content).toContain('type: acceptance_result');
      expect(content).toContain('priority: normal');
      expect(content).toContain('from: "contract_system"');
      expect(content).toContain('to: "test-claw"');
      expect(content).toContain(`contract_id: "${contractId}"`);
      expect(content).toContain('subtask_id: "task-1"');
      expect(content).toContain('verdict: "passed"');

      // passed 时不应含 retry_count
      expect(content).not.toContain('retry_count');
    });

    it('should write rejected message with correct frontmatter, high priority, and retry_count', async () => {
      const contractId = 'test-inbox-rejected';
      await setupContract(tempDir, contractId, {
        schema_version: 1,
        title: 'Test Contract',
        goal: 'Test goal',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        acceptance: [{ subtask_id: 'task-1', type: 'script', script_file: 'acceptance/task-1.sh' }],
        escalation: { max_retries: 3 },
      });

      const acceptanceDir = path.join(tempDir, 'contract', 'active', contractId, 'acceptance');
      await fs.mkdir(acceptanceDir, { recursive: true });
      await fs.writeFile(path.join(acceptanceDir, 'task-1.sh'), '#!/bin/bash\nexit 1', { mode: 0o755 });

      execFileMockBehavior = 'fail';
      execFileMockStderr = 'file not found';

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptance(tempDir);

      const inbox = await readClawInbox(tempDir);
      expect(inbox).toHaveLength(1);

      const { filename, content } = inbox[0];
      // 文件名含 _high_
      expect(filename).toContain('_high_');

      // 核心字段
      expect(content).toContain('type: acceptance_rejection');
      expect(content).toContain('priority: high');
      expect(content).toContain('from: "contract_system"');
      expect(content).toContain('to: "test-claw"');
      expect(content).toContain(`contract_id: "${contractId}"`);
      expect(content).toContain('subtask_id: "task-1"');
      expect(content).toContain('verdict: "rejected"');
      expect(content).toContain('retry_count: 1');
    });
  });
});

describe('ContractSystem — background acceptance error handling', () => {
  it('catches TypeError in fire-and-forget acceptance and emits UNEXPECTED_ASYNC_THROW audit', async () => {
    const auditEvents: Array<{ type: string; cols: string[] }> = [];
    const captureAudit = {
      write: (type: string, ...cols: string[]) => { auditEvents.push({ type, cols }); },
    };

    const rootDir = await createTempDir();
    const clawDir = path.join(rootDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;
    const manager = new ContractSystem(
      clawDir, 'test-claw', nodeFs, captureAudit as any, mockLLM,
    );

    const contractId = 'typeerror-test-contract';
    const subtaskId = 'task-1';
    await setupContract(clawDir, contractId, {
      schema_version: 1,
      title: 'TypeError Test',
      goal: 'Test TypeError catch',
      subtasks: [{ id: subtaskId, description: 'Verify TypeError audit' }],
      acceptance: [{ subtask_id: subtaskId, type: 'llm', prompt_file: `acceptance/${subtaskId}.prompt.txt` }],
    }, { [subtaskId]: 'todo' });
    await fs.mkdir(path.join(clawDir, 'contract', 'active', contractId, 'acceptance'), { recursive: true });
    await fs.writeFile(
      path.join(clawDir, 'contract', 'active', contractId, 'acceptance', `${subtaskId}.prompt.txt`),
      'Evidence: {{evidence}}',
    );

    // Mock loadContractYaml to return malformed YAML (subtasks missing) after setup.
    // This causes TypeError in _runAcceptanceInBackground when it calls contractYaml.subtasks.find,
    // which bubbles to the .catch block on L545.
    vi.spyOn(manager as any, 'loadContractYaml').mockResolvedValue({
      schema_version: 1,
      title: 'TypeError Test',
      goal: 'Test TypeError catch',
      acceptance: [{ subtask_id: subtaskId, type: 'llm', prompt_file: `acceptance/${subtaskId}.prompt.txt` }],
      // subtasks intentionally omitted to trigger TypeError
    });

    await manager.completeSubtask({ contractId, subtaskId, evidence: 'done' });

    // Wait for background acceptance to settle
    await new Promise(r => setTimeout(r, 100));

    expect(auditEvents.some(e => e.type === 'contract_unexpected_async_throw')).toBe(true);
    const throwAudit = auditEvents.find(e => e.type === 'contract_unexpected_async_throw');
    expect(throwAudit?.cols.some(c => c.startsWith('errorType=TypeError'))).toBe(true);
    expect(throwAudit?.cols.some(c => c.startsWith('error='))).toBe(true);

    await cleanupTempDir(rootDir);
  });

  it('does NOT emit UNEXPECTED_ASYNC_THROW for business errors in background acceptance', async () => {
    const auditEvents: Array<{ type: string; cols: string[] }> = [];
    const captureAudit = {
      write: (type: string, ...cols: string[]) => { auditEvents.push({ type, cols }); },
    };

    const rootDir = await createTempDir();
    const clawDir = path.join(rootDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;
    const manager = new ContractSystem(
      clawDir, 'test-claw', nodeFs, captureAudit as any, mockLLM,
    );

    const contractId = 'business-error-test-contract';
    const subtaskId = 'task-1';
    await setupContract(clawDir, contractId, {
      schema_version: 1,
      title: 'Business Error Test',
      goal: 'Test business error catch',
      subtasks: [{ id: subtaskId, description: 'Verify business error audit' }],
      acceptance: [{ subtask_id: subtaskId, type: 'llm', prompt_file: `acceptance/${subtaskId}.prompt.txt` }],
    }, { [subtaskId]: 'todo' });
    await fs.mkdir(path.join(clawDir, 'contract', 'active', contractId, 'acceptance'), { recursive: true });
    await fs.writeFile(
      path.join(clawDir, 'contract', 'active', contractId, 'acceptance', `${subtaskId}.prompt.txt`),
      'Evidence: {{evidence}}',
    );

    // Mock loadContractYaml to return subtasks with a find() that throws plain Error.
    // This causes a business Error in _runAcceptanceInBackground, which bubbles to .catch
    // but should NOT trigger UNEXPECTED_ASYNC_THROW (only ACCEPTANCE_RESET_FAILED).
    vi.spyOn(manager as any, 'loadContractYaml').mockResolvedValue({
      schema_version: 1,
      title: 'Business Error Test',
      goal: 'Test business error catch',
      acceptance: [{ subtask_id: subtaskId, type: 'llm', prompt_file: `acceptance/${subtaskId}.prompt.txt` }],
      subtasks: {
        find() { throw new Error('LLM rate limit exceeded'); },
      },
    });

    await manager.completeSubtask({ contractId, subtaskId, evidence: 'done' });

    // Wait for background acceptance to settle
    await new Promise(r => setTimeout(r, 100));

    expect(auditEvents.some(e => e.type === 'contract_unexpected_async_throw')).toBe(false);
    expect(auditEvents.some(e => e.type === 'contract_acceptance_background_failed')).toBe(true);

    await cleanupTempDir(rootDir);
  });
});
