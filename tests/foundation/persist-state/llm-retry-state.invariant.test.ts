import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { Runtime } from '../../../src/core/runtime/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

async function makeTempAgentDir() {
  const tmpDir = await createTrackedTempDir('llm-retry-inv-');
  fsNative.mkdirSync(path.join(tmpDir, 'inbox', 'pending'), { recursive: true });
  return tmpDir;
}

async function cleanup(dir: string) {
  try {
    await cleanupTempDir(dir);
  } catch { /* ignore cleanup failure */ }
}

function makeMockAudit() {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  };
}

function makeMockRecovery() {
  return {
    inspect: vi.fn().mockResolvedValue({ kind: 'ready', revision: 1 }),
    begin: vi.fn().mockResolvedValue({ kind: 'admitted', attemptId: 'att-test', factsAccepted: true }),
    finish: vi.fn().mockResolvedValue(undefined),
    adoptLegacy: vi.fn().mockReturnValue({ kind: 'imported' }),
  };
}

function makeEventLoop(agentDir: string, audit: AuditLog, runtime?: Partial<Runtime>) {
  return new EventLoop({
    runtime: (runtime ?? {
      // Phase 1847: 空批次 mock 迁新边界两方法（prepare 返回空原批次，format 不被消费）
      prepareInbox: vi.fn().mockResolvedValue({ entries: [] }),
      formatPreparedInbox: vi.fn().mockResolvedValue({ injected: [], sources: [], count: 0, infos: [] }),
      getSystemPrompt: vi.fn().mockResolvedValue(''),
      getToolsForLLM: vi.fn().mockReturnValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: any[]) => m),
      processTurn: vi.fn().mockResolvedValue({ status: 'success' }),
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
    }) as Runtime,
    fsFactory,
    agentDir,
    clawId: 'llm-retry-test',
    audit,
    inbox: { pendingDir: path.join(agentDir, 'inbox', 'pending'), fallbackTimeoutMs: 1_000 },
    // Phase 1826: 旧 LLM 恢复状态由旧 owner 读取导出、owner 幂等导入；
    // 无 owner 注入时不做迁移读取（也不产生 load 类 audit）。
    recovery: makeMockRecovery(),
  });
}

describe('llm-retry state load invariants', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ENOENT silently uses defaults (first start)', async () => {
    const agentDir = await makeTempAgentDir();
    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('loadLlmRetryState')));
    expect(loadFailedCalls).toHaveLength(0);
    await cleanup(agentDir);
  });

  it('read_failed emits audit with reason=read_failed', async () => {
    const agentDir = await makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    fsNative.writeFileSync(path.join(agentDir, 'status', 'llm-retry-state.json'), 'any');
    if (process.platform !== 'win32') {
      fsNative.chmodSync(path.join(agentDir, 'status', 'llm-retry-state.json'), 0o000);
    }

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    if (process.platform !== 'win32') {
      const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('reason=read_failed')));
      expect(loadFailedCalls.length).toBeGreaterThanOrEqual(1);
      fsNative.chmodSync(path.join(agentDir, 'status', 'llm-retry-state.json'), 0o644);
    }
    await cleanup(agentDir);
  });

  it('parse_failed emits audit with reason=parse_failed', async () => {
    const agentDir = await makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    fsNative.writeFileSync(path.join(agentDir, 'status', 'llm-retry-state.json'), 'not-json{');

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('reason=parse_failed')));
    expect(loadFailedCalls.length).toBeGreaterThanOrEqual(1);
    await cleanup(agentDir);
  });

  it('future schema_version emits schema_version_mismatch audit', async () => {
    const agentDir = await makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    // Phase 1268 Step B: schema v2 合法后，mismatch 语义由 future schema 锁定。
    fsNative.writeFileSync(
      path.join(agentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 99, llmRetryCount: 1, llmRetryDelayMs: 1000, llmRetryPending: false, waiting: null }),
    );

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('reason=schema_version_mismatch')));
    expect(loadFailedCalls.length).toBeGreaterThanOrEqual(1);
    await cleanup(agentDir);
  });

  it('v2 with invalid waiting field emits field_type_mismatch audit', async () => {
    const agentDir = await makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    fsNative.writeFileSync(
      path.join(agentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 2, llmRetryCount: 1, llmRetryDelayMs: 1000, llmRetryPending: false, waiting: { kind: 'unknown' } }),
    );

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('reason=field_type_mismatch')));
    expect(loadFailedCalls.length).toBeGreaterThanOrEqual(1);
    await cleanup(agentDir);
  });

  it('valid schema_version=2 with waiting applies state (no fatal audit)', async () => {
    const agentDir = await makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    fsNative.writeFileSync(
      path.join(agentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({
        schema_version: 2,
        llmRetryCount: 1,
        llmRetryDelayMs: 2000,
        llmRetryPending: false,
        waiting: {
          kind: 'retry',
          requestFingerprint: 'fp-v2',
          errorClass: 'rate_limit',
          attempt: 1,
          maxAttempts: 3,
          scheduledAt: new Date().toISOString(),
          resumeAt: new Date(Date.now() + 60_000).toISOString(),
          error: 'rate limited',
        },
      }),
    );

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('loadLlmRetryState')));
    expect(loadFailedCalls).toHaveLength(0);
    await cleanup(agentDir);
  });

  it('field_type_mismatch emits audit', async () => {
    const agentDir = await makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    fsNative.writeFileSync(
      path.join(agentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 1, llmRetryCount: 'invalid', llmRetryDelayMs: 1000, llmRetryPending: false }),
    );

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('reason=field_type_mismatch')));
    expect(loadFailedCalls.length).toBeGreaterThanOrEqual(1);
    await cleanup(agentDir);
  });

  it('valid schema_version=1 + valid fields applies state', async () => {
    const agentDir = await makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    fsNative.writeFileSync(
      path.join(agentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 1, llmRetryCount: 5, llmRetryDelayMs: 2000, llmRetryPending: true }),
    );

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('loadLlmRetryState')));
    expect(loadFailedCalls).toHaveLength(0);
    await cleanup(agentDir);
  });
});
