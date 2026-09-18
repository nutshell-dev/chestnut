/**
 * phase 1863 (AT-D12)：统一投递证据（DeliveryEvidence）+ 两路径策略矩阵。
 *
 * Coverage:
 * - subagent 路径（marker_before_delete）：delivered + atLeastOnceWindow=true + SENT_MARKER 写入
 * - tool 路径（idempotent_redeliver）：delivered + atLeastOnceWindow=false + 无 marker
 * - fallback：subagent 写 marker（窗口真） / tool 不写
 * - lifecycle 门：deliverySink 返回非 delivered → 任务留 running（不终态移动）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendResult,
  sendFallbackResult,
  sendToolResult,
  createStandardDeliverySink,
} from '../../../src/core/async-task-system/result-delivery.js';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { makeFullTaskId, makeShortTaskId } from '../../../src/core/async-task-system/types.js';
import type { SubAgentTask, ToolTask } from '../../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

function makeMockAudit(): AuditLog {
  return { write: vi.fn(), preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s };
}

function makeSubagentTask(): SubAgentTask {
  return {
    kind: 'subagent',
    id: makeFullTaskId('550e8400-e29b-41d4-a716-446655440000'),
    shortId: makeShortTaskId('550e8400'),
    mode: 'standard',
    intent: 'test',
    timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
    maxSteps: 5,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
  };
}

function makeToolTask(): ToolTask {
  return {
    kind: 'tool',
    id: makeFullTaskId('550e8400-e29b-41d4-a716-446655440001'),
    shortId: makeShortTaskId('550e8401'),
    toolName: 'exec',
    args: { command: 'echo hi' },
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
  };
}

describe('delivery evidence (phase 1863 AT-D12)', () => {
  let mockFs: FileSystem & { writeAtomic: ReturnType<typeof vi.fn> };
  let audit: AuditLog;
  let writeAtomicCalls: Array<[string, string]>;

  beforeEach(() => {
    writeAtomicCalls = [];
    mockFs = {
      writeAtomic: vi.fn((p: string, c: string) => {
        writeAtomicCalls.push([p, c]);
        return Promise.resolve();
      }),
      ensureDir: vi.fn().mockResolvedValue(undefined),
      ensureDirSync: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem & { writeAtomic: ReturnType<typeof vi.fn> };
    audit = makeMockAudit();
  });

  it('subagent 路径（marker_before_delete）：delivered + 窗口真 + SENT_MARKER 写入', async () => {
    const evidence = await sendResult(mockFs, audit, makeSubagentTask(),
      { schema_version: 1, content: 'ok', isError: false }, { writeInboxAsync: vi.fn().mockResolvedValue(undefined) });

    expect(evidence).toEqual({ kind: 'delivered', atLeastOnceWindow: true });
    expect(writeAtomicCalls.some(c => c[0].endsWith('.sent'))).toBe(true);
  });

  it('tool 路径（idempotent_redeliver）：delivered + 窗口假 + 无 marker', async () => {
    const evidence = await sendToolResult(mockFs, audit, makeToolTask(), 'ok', false,
      { writeInboxAsync: vi.fn().mockResolvedValue(undefined) });

    expect(evidence).toEqual({ kind: 'delivered', atLeastOnceWindow: false });
    expect(writeAtomicCalls.some(c => c[0].endsWith('.sent'))).toBe(false);
  });

  it('fallback：subagent 写 marker（窗口真）/ tool 不写（窗口假）', async () => {
    const subEvidence = await sendFallbackResult(mockFs, audit, makeSubagentTask(),
      { schema_version: 1, content: 'fb', isError: true }, { writeInboxAsync: vi.fn().mockResolvedValue(undefined) });
    expect(subEvidence).toEqual({ kind: 'delivered', atLeastOnceWindow: true });

    writeAtomicCalls.length = 0;
    const toolEvidence = await sendFallbackResult(mockFs, audit, makeToolTask(),
      { schema_version: 1, content: 'fb', isError: true }, { writeInboxAsync: vi.fn().mockResolvedValue(undefined) });
    expect(toolEvidence).toEqual({ kind: 'delivered', atLeastOnceWindow: false });
    expect(writeAtomicCalls.some(c => c[0].endsWith('.sent'))).toBe(false);
  });

  it('标准 sink 透传 sendResult 证据（统一形态）', async () => {
    const sink = createStandardDeliverySink({ writeInboxAsync: vi.fn().mockResolvedValue(undefined) });
    const evidence = await sink.deliver(makeSubagentTask(), { schema_version: 1, content: 'ok', isError: false },
      { fs: mockFs, auditWriter: audit });
    expect(evidence).toEqual({ kind: 'delivered', atLeastOnceWindow: true });
  });

  it('lifecycle 门：sink 返回非 delivered → 任务留 running（不终态移动）', async () => {
    const task = makeSubagentTask();
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, {
      fs: mockFs,
      fsFactory: () => mockFs,
      auditWriter: audit,
      clawDir: '/tmp/test-claw',
      postProcessors: new Map(),
      moveTaskToDone,
      moveTaskToFailed,
      taskExecutor: { execute: async () => ({ content: 'ran', sourceIsError: false }) },
      deliverySink: { deliver: async () => ({ kind: 'resend_window', atLeastOnceWindow: true, reason: 'inbox_unavailable' }) },
    });

    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
  });
});
