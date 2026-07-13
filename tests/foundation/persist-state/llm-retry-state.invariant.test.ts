import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { Runtime } from '../../../src/core/runtime/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

function makeTempAgentDir() {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpDir = fsNative.mkdtempSync(path.join(os.tmpdir(), 'llm-retry-inv-'));
  fsNative.mkdirSync(path.join(tmpDir, 'inbox', 'pending'), { recursive: true });
  return tmpDir;
}

function cleanup(dir: string) {
  try {
    fsNative.rmSync(dir, { recursive: true, force: true });
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

function makeEventLoop(agentDir: string, audit: AuditLog, runtime?: Partial<Runtime>) {
  return new EventLoop({
    runtime: (runtime ?? {
      drainInbox: vi.fn().mockResolvedValue({ injected: [], sources: [], count: 0, infos: [], addressedHandles: [] }),
      getSystemPrompt: vi.fn().mockResolvedValue(''),
      getToolsForLLM: vi.fn().mockReturnValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: any[]) => m),
      processTurn: vi.fn().mockResolvedValue({ status: 'success' }),
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      retryLastTurn: vi.fn().mockResolvedValue({ status: 'success' }),
      abort: vi.fn(),
    }) as Runtime,
    fsFactory,
    agentDir,
    clawId: 'llm-retry-test',
    audit,
    inbox: { pendingDir: path.join(agentDir, 'inbox', 'pending'), fallbackTimeoutMs: 1_000 },
  });
}

describe('llm-retry state load invariants', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ENOENT silently uses defaults (first start)', async () => {
    const agentDir = makeTempAgentDir();
    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('loadLlmRetryState')));
    expect(loadFailedCalls).toHaveLength(0);
    cleanup(agentDir);
  });

  it('read_failed emits audit with reason=read_failed', async () => {
    const agentDir = makeTempAgentDir();
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
    cleanup(agentDir);
  });

  it('parse_failed emits audit with reason=parse_failed', async () => {
    const agentDir = makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    fsNative.writeFileSync(path.join(agentDir, 'status', 'llm-retry-state.json'), 'not-json{');

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('reason=parse_failed')));
    expect(loadFailedCalls.length).toBeGreaterThanOrEqual(1);
    cleanup(agentDir);
  });

  it('schema_version_mismatch emits audit', async () => {
    const agentDir = makeTempAgentDir();
    fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
    fsNative.writeFileSync(
      path.join(agentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 2, llmRetryCount: 1, llmRetryDelayMs: 1000, llmRetryPending: false }),
    );

    const audit = makeMockAudit();
    const eventLoop = makeEventLoop(agentDir, audit as unknown as AuditLog);

    await eventLoop.initialize();

    const loadFailedCalls = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('reason=schema_version_mismatch')));
    expect(loadFailedCalls.length).toBeGreaterThanOrEqual(1);
    cleanup(agentDir);
  });

  it('field_type_mismatch emits audit', async () => {
    const agentDir = makeTempAgentDir();
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
    cleanup(agentDir);
  });

  it('valid schema_version=1 + valid fields applies state', async () => {
    const agentDir = makeTempAgentDir();
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
    cleanup(agentDir);
  });
});
