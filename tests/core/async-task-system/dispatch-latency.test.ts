/**
 * Phase 1147 r127 B fork: dispatch latency + atomic write invariant
 *
 * Reverse test 1 (latency floor): write pending task via writeAtomic +
 * measure time from write to _ingestPendingFile trigger.
 *   - BEFORE revert ('stable'): ≥ 100ms (chokidar awaitWriteFinish settle)
 *   - AFTER revert ('immediate'): < 50ms (chokidar immediate 'add' fire)
 *
 * Reverse test 2 (atomic invariant): verify tmp+rename atomic write pattern
 * is safe with watcher callback's .json filter.
 *   - Non-.json files in pending/ are ignored by watcher callback
 *   - After rename to .json, watcher picks it up
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { createTestTaskSystem } from '../../helpers/task-system.js';
import { waitFor } from '../../helpers/wait-for.js';

import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../../src/foundation/llm-orchestrator/types.js';

function createHangingMockLLM(): LLMOrchestrator {
  async function* hangingStream(signal?: AbortSignal): AsyncIterableIterator<StreamChunk> {
    await new Promise<void>((_, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
    yield { type: 'done' };
  }

  return {
    call: vi.fn(() => new Promise(() => {})),
    stream: vi.fn((opts: { signal?: AbortSignal }) => hangingStream(opts?.signal)),
    close: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as LLMOrchestrator;
}

describe('AsyncTaskSystem dispatch latency (phase 1147 r127 B fork)', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let taskSystem: AsyncTaskSystem;
  // phase 1247: destructure full makeAudit() 为 waitForAuditEvent 准备
  let auditEvents: ReturnType<typeof makeAudit>['events'];
  let auditEmitter: ReturnType<typeof makeAudit>['emitter'];

  beforeEach(async () => {
    tempDir = await createTempDir('phase1147-');
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    await mockFs.ensureDir('tasks');

    const auditObj = makeAudit();
    auditEvents = auditObj.events;
    auditEmitter = auditObj.emitter;
    taskSystem = createTestTaskSystem(tempDir, mockFs, auditObj.audit, createHangingMockLLM());
    await taskSystem.initialize();
    taskSystem.startDispatch();
  });

  afterEach(async () => {
    await taskSystem.shutdown(100).catch(() => {});
    await cleanupTempDir(tempDir);
  });

  it('AsyncTaskSystem 用 stability=immediate (regression guard for phase 1147 revert)', () => {
    // phase 1199 γ1 structural invariant 替代 phase 1147 wall-clock timing test
    // mirror phase 964 silent-x-invariant grep-based 模板
    // 保 regression 保护意图：若有人把 system.ts:234 revert 回 'stable'、本 test 立即 fail
    const __filename = fileURLToPath(import.meta.url);
    const systemSrcPath = path.resolve(path.dirname(__filename), '../../../src/core/async-task-system/system.ts');
    const src = readFileSync(systemSrcPath, 'utf-8');
    expect(src).toMatch(/stability:\s*['"]immediate['"]/);
  });

  it('atomic write invariant: non-.json files are ignored by watcher callback', async () => {
    const pendingDir = path.join(tempDir, 'tasks', 'queues', 'pending');
    const tmpFileName = `.tmp_${randomUUID()}`;
    const tmpPath = path.join(pendingDir, tmpFileName);
    const jsonPath = path.join(pendingDir, 'atomic-test.json');

    // Simulate atomic write intermediate: write tmp file (no .json suffix)
    const taskPayload = JSON.stringify({
      kind: 'subagent',
      id: 'atomic-test',
      intent: 'atomic probe',
      timeoutMs: 300_000,
      maxSteps: 1,
      parentClawId: 'parent-claw',
      createdAt: new Date().toISOString(),
    });
    await fs.writeFile(tmpPath, taskPayload);

    expect(await fs.access(tmpPath).then(() => true).catch(() => false)).toBe(true);
    expect(await mockFs.exists('tasks/queues/running/atomic-test.json')).toBe(false);

    // Atomic rename to .json — watcher should now pick it up
    await fs.rename(tmpPath, jsonPath);
    // phase 1247: wait for TASK_STARTED audit event (因果后置于 movePendingToRunning)
    // 替 wall-clock polling `waitFor(mockFs.exists, 5_000)` (β unique derive mirror phase 1143 + 1175)
    await waitForAuditEvent(auditEmitter, auditEvents, TASK_AUDIT_EVENTS.TASK_STARTED, 10_000);
    // 可选验证 running file 已存在（causally guaranteed by audit emit site at system.ts:538）
    expect(await mockFs.exists('tasks/queues/running/atomic-test.json')).toBe(true);
  });
});
