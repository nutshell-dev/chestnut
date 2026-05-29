/**
 * ContractSystem LLM/Script verification integration tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { EventEmitter, once } from 'events';

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

import { DEFAULT_MAX_STEPS } from '../../src/core/agent-executor/index.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

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
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
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
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return [];
  }
}

/**
 * Wait for VERIFICATION_BACKGROUND_DONE audit event for a specific contract/subtask.
 * Replaces fs polling for deterministic background completion detection.
 */
async function waitForAcceptanceDone(
  auditEmitter: EventEmitter,
  contractId: string,
  subtaskId: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      auditEmitter.off('write', handler);
      reject(new Error(`waitForAcceptanceDone timeout: ${contractId}/${subtaskId}`));
    }, timeoutMs);
    const handler = (ev: string, ...args: string[]) => {
      if (
        ev === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE
        && args.includes(`contractId=${contractId}`)
        && args.includes(`subtaskId=${subtaskId}`)
      ) {
        clearTimeout(timer);
        auditEmitter.off('write', handler);
        resolve();
      }
    };
    auditEmitter.on('write', handler);
  });
}

describe('ContractSystem Acceptance Flow', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let mockAudit: { write: ReturnType<typeof vi.fn> };
  let auditEmitter: EventEmitter;
  let mockLLM: LLMOrchestrator;
  // mockRegistry removed — ToolRegistryImpl internalized in VerifierScheduler (phase364)

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    const cp = await import('child_process');
    vi.mocked(cp.spawn).mockImplementation((file: string, args: string[], options: any) => {
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
    });

    const { SubAgent } = await import('../../src/core/subagent/agent.js');
    vi.mocked(SubAgent).mockImplementation((opts: any) => {
      capturedSubAgentRegistry = opts.registry ?? null;
      capturedOnIdleTimeout = opts.onIdleTimeout ?? null;
      return { run: mockSubAgentRun };
    });

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
    const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
    const logsDir = path.join(clawDir, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    auditEmitter = new EventEmitter();
    mockAudit = {
      write: vi.fn((type: string, ...cols: string[]) => {
        auditEmitter.emit('write', type, ...cols);
      }),
    };

    mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;

    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      llm: mockLLM,
      toolRegistry: createToolRegistry(),
      fsFactory
    });
  });

  afterEach(async () => {
    // 清理 rootDir（clawDir 的祖父目录）
    await cleanupTempDir(path.resolve(clawDir, '..', '..'));
  });

  describe('Script Acceptance', () => {
    it('should reject path traversal attack in script_file', async () => {
      const contractId = 'test-contract-1';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'script', script_file: '../../../etc/passwd' }],
      }));

      const result = await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      expect(result.async).toBe(true);
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('verification_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('路径安全');
    });

    it('should pass when script verification succeeds', async () => {
      const contractId = 'test-contract-2';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(path.join(verificationDir, 'task-1.sh'), '#!/bin/bash\necho "ok"', { mode: 0o755 });

      // Set execFile mock to succeed
      execFileMockBehavior = 'success';
      execFileMockStdout = 'ok';

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      // Wait for background verification to finish before reading files (phase 779 Step A)
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      // inbox 写完后 progress 必已落地；读哪条路径都行
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
      const results = inbox.filter(m => m.content.includes('verification_result'));
      expect(results.length).toBeGreaterThan(0);
    });

    it('should fail and increment retry_count when script verification fails', async () => {
      const contractId = 'test-contract-3';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification_attempts: 3,
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(path.join(verificationDir, 'task-1.sh'), '#!/bin/bash\necho "fail"\nexit 1', { mode: 0o755 });

      // Set execFile mock to fail
      execFileMockBehavior = 'fail';
      execFileMockStderr = 'test error output';

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const progressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      expect(progress.subtasks['task-1'].retry_count).toBe(1);
      expect(progress.subtasks['task-1'].status).toBe('todo');

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('verification_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('test error output');
    });

    it('should return rejection when script verification config has no script_file', async () => {
      const contractId = 'test-script-no-file';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        // type: 'script' 但故意缺 script_file
        verification: [{ subtask_id: 'task-1', type: 'script' }],
      }));

      const result = await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });
      expect(result.async).toBe(true);
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('verification_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('缺少 script_file');
    });

    it('should log warn to monitor when script verification config has no script_file', async () => {
      const logSpy = vi.spyOn(mockAudit, 'write');
      const contractId = 'test-script-no-file-monitor';
      await setupContract(tempDir, contractId, makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'script' }], // 故意缺 script_file
      }));

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'e' });
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      expect(logSpy).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED,
        expect.stringContaining('context=ContractSystem.runVerificationByType'),
        expect.anything(),
      );
    });
  });

  describe('LLM Acceptance', () => {
    it('should pass when LLM verification returns passed=true', async () => {
      const contractId = 'test-contract-4';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(path.join(verificationDir, 'task-1.prompt.txt'), 'Check if {{evidence}} is valid');

      mockSubAgentRun.mockResolvedValue('{"passed":true,"reason":"looks good","issues":[]}');

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      // Wait for background verification to finish (phase 779 Step A)
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      // inbox 写完后 progress 必已落地；读哪条路径都行
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
      const results = inbox.filter(m => m.content.includes('verification_result'));
      expect(results.length).toBeGreaterThan(0);
    });

    it('should fail and format rejection when LLM returns passed=false', async () => {
      const contractId = 'test-contract-5';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task implementation' }],
        verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
        verification_attempts: 3,
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(path.join(verificationDir, 'task-1.prompt.txt'), 'Check if {{evidence}} is valid');

      mockSubAgentRun.mockResolvedValue(
        '{"passed":false,"reason":"缺少测试","issues":["add unit tests", "add integration tests"]}'
      );

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const progressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      expect(progress.subtasks['task-1'].retry_count).toBe(1);

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('verification_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('缺少测试');
    });

    it('should reject path traversal in prompt_file', async () => {
      const contractId = 'test-contract-6';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: '../../../etc/passwd' }],
      }));

      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });

      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('verification_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('路径安全');
    });

    it('should return rejection when llm verification config has no prompt_file', async () => {
      const contractId = 'test-llm-no-file';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        // type: 'llm' 但故意缺 prompt_file
        verification: [{ subtask_id: 'task-1', type: 'llm' }],
      }));

      const result = await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });
      expect(result.async).toBe(true);
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('verification_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('缺少 prompt_file');
    });

    it('should return rejection when LLM is not injected in ContractSystem', async () => {
      const contractId = 'test-llm-not-injected';
      // manager without llm
      const nodeFs = new NodeFileSystem({ baseDir: clawDir });
      const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
      const noLLMManager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory
      });

      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
      }));

      const result = await noLLMManager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'test evidence',
      });
      expect(result.async).toBe(true);
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('verification_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('LLM 验收未配置');
    });

    it('should log warn to monitor when llm verification config has no prompt_file', async () => {
      const logSpy = vi.spyOn(mockAudit, 'write');
      const contractId = 'test-llm-no-prompt-monitor';
      await setupContract(tempDir, contractId, makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'llm' }], // 故意缺 prompt_file
      }));

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'e' });
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      expect(logSpy).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED,
        expect.stringContaining('context=ContractSystem.runVerificationByType'),
        expect.anything(),
      );
    });

    it('should prefer capturedResult over text when done tool is called', async () => {
      const contractId = 'test-llm-captured';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(
        path.join(verificationDir, 'task-1.prompt.txt'),
        'Check if {{evidence}} is valid. {{artifacts}}'
      );

      // SubAgent.run() 调用 done 工具后返回任意文字（应被忽略）
      mockSubAgentRun.mockImplementation(async () => {
        // 模拟 LLM 在 run() 内部调用了 done 工具
        if (capturedSubAgentRegistry) {
          const doneTool = capturedSubAgentRegistry.get('done');
          if (doneTool) {
            await doneTool.execute(
              { result: JSON.stringify({ passed: true, reason: 'all checks passed via tool' }) },
              { requestStop: () => { /* no-op */ } } as any
            );
          }
        }
        return 'irrelevant text that is not JSON'; // 文本不含 JSON，但应被忽略
      });

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });

      // Wait for background verification to finish (phase 779 Step A)
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

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
      expect(inbox.filter(m => m.content.includes('verification_result'))).toHaveLength(1);
    });

    it('should return rejection with "无法解析 JSON" when LLM text has no JSON', async () => {
      const contractId = 'test-llm-no-json';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
        verification_attempts: 3,
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(
        path.join(verificationDir, 'task-1.prompt.txt'),
        'Check if {{evidence}} is valid. {{artifacts}}'
      );

      // SubAgent 未调用 done，返回纯文字（无 JSON）
      mockSubAgentRun.mockResolvedValue('I reviewed the evidence but cannot determine a verdict.');

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      // 应以 rejected 写入 inbox，内容含 "无法解析 JSON"
      const inbox = await readClawInbox(tempDir);
      const rejections = inbox.filter(m => m.content.includes('verification_rejection'));
      expect(rejections).toHaveLength(1);
      expect(rejections[0].content).toContain('无法解析 JSON');

      // subtask 应重置为 todo，retry_count = 1
      const progressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      expect(progress.subtasks['task-1'].status).toBe('todo');
      expect(progress.subtasks['task-1'].retry_count).toBe(1);
    });

    it('should notify Motion with verification_timeout when onIdleTimeout is triggered', async () => {
      const contractId = 'test-llm-timeout';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(
        path.join(verificationDir, 'task-1.prompt.txt'),
        'Check if {{evidence}} is valid. {{artifacts}}'
      );

      // SubAgent.run() 在执行中途触发 idle timeout 回调，然后返回空文字
      mockSubAgentRun.mockImplementation(async () => {
        capturedOnIdleTimeout?.();
        return '{}'; // 返回合法 JSON 确保主流程继续（避免额外 rejection 干扰）
      });

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      // auditWriter 应收到 verification_timeout 日志
      const auditWriter = (manager as any).audit;
      const timeoutCalls = auditWriter.write.mock.calls.filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_TIMEOUT);
      expect(timeoutCalls).toHaveLength(1);
      expect(timeoutCalls[0]).toEqual(expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.VERIFICATION_TIMEOUT,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=task-1'),
      ]));
    });
  });

  describe('Force-accept', () => {
    it('should write force-accept audit when retry_count reaches max_attempts', async () => {
      const contractId = 'test-contract-7';
      // Setup contract with verification_attempts=2
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification_attempts: 2,
      }), { 'task-1': 'todo' });

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(path.join(verificationDir, 'task-1.sh'), '#!/bin/bash\nexit 1', { mode: 0o755 });

      // Pre-set retry_count to 1 (simulating one previous failure)
      // This means this failure will push it to 2, triggering force-accept
      const activeProgressPath = path.join(tempDir, 'contract', 'active', contractId, 'progress.json');
      const archiveProgressPath = path.join(tempDir, 'contract', 'archive', contractId, 'progress.json');
      const initialProgress = JSON.parse(await fs.readFile(activeProgressPath, 'utf-8'));
      initialProgress.subtasks['task-1'].retry_count = 1;
      await fs.writeFile(activeProgressPath, JSON.stringify(initialProgress, null, 2));

      // Set execFile to fail
      execFileMockBehavior = 'fail';
      execFileMockStderr = 'test failure';

      // This failure should push retry_count to 2, triggering force-accept audit
      const auditWriter = (manager as any).audit;
      await manager.completeSubtask({
        contractId,
        subtaskId: 'task-1',
        evidence: 'attempt 2',
      });

      // Wait for background verification to finish (ensures saveProgress + archiveAndEmit have completed)
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      let progress: any;
      try {
        progress = JSON.parse(await fs.readFile(archiveProgressPath, 'utf-8'));
      } catch {
        progress = JSON.parse(await fs.readFile(activeProgressPath, 'utf-8'));
      }
      expect(progress.subtasks['task-1'].retry_count).toBe(2);

      const forceAcceptCalls = auditWriter.write.mock.calls.filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED);
      expect(forceAcceptCalls.length).toBeGreaterThan(0);
      expect(forceAcceptCalls[0]).toEqual(expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=task-1'),
      ]));
    });
  });

  describe('phase230 audit events', () => {
    it('writes CONTRACT_VERIFICATION_SCRIPT_STARTED audit when running script verification', async () => {
      const contractId = 'test-script-audit';
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(path.join(verificationDir, 'task-1.sh'), '#!/bin/bash\necho "ok"', { mode: 0o755 });

      execFileMockBehavior = 'success';

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const auditWriter = (manager as any).audit;
      expect(auditWriter.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.VERIFICATION_SCRIPT_STARTED,
        expect.stringContaining('script='),
        expect.stringContaining('cwd='),
      );
    });

    it('writes CONTRACT_VERIFICATION_RESET_FAILED when reset status fails', async () => {
      const lockSpy = vi.spyOn(manager as any, 'withProgressLock').mockRejectedValue(new Error('lock busy'));

      try {
        // @ts-expect-error - private method
        await manager._writeVerificationError('contract-1', 'task-1', new Error('verification crashed'));

        const auditWriter = (manager as any).audit;
        expect(auditWriter.write).toHaveBeenCalledWith(
          CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED,
          expect.stringContaining('context=ContractSystem._writeVerificationError.resetStatus'),
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
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(path.join(verificationDir, 'task-1.sh'), '#!/bin/bash\nexit 0', { mode: 0o755 });

      execFileMockBehavior = 'success';

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const inbox = await readClawInbox(tempDir);
      expect(inbox).toHaveLength(1);

      const { filename, content } = inbox[0];
      // 文件名含 _normal_
      expect(filename).toContain('_normal_');

      // 核心字段
      expect(content).toContain('type: verification_result');
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
      await setupContract(tempDir, contractId, makeContractYaml({
        subtasks: [{ id: 'task-1', description: 'Test task' }],
        verification_attempts: 3,
      }));

      const verificationDir = path.join(tempDir, 'contract', 'active', contractId, 'verification');
      await fs.mkdir(verificationDir, { recursive: true });
      await fs.writeFile(path.join(verificationDir, 'task-1.sh'), '#!/bin/bash\nexit 1', { mode: 0o755 });

      execFileMockBehavior = 'fail';
      execFileMockStderr = 'file not found';

      await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
      await waitForAcceptanceDone(auditEmitter, contractId, 'task-1');

      const inbox = await readClawInbox(tempDir);
      expect(inbox).toHaveLength(1);

      const { filename, content } = inbox[0];
      // 文件名含 _high_
      expect(filename).toContain('_high_');

      // 核心字段
      expect(content).toContain('type: verification_rejection');
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
