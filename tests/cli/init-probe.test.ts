/**
 * Phase 1470 — init.ts LLM API probe + reconfigure failure paths
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// ── readline mock ──────────────────────────────────────────────────────────────
const { rlAnswers } = vi.hoisted(() => ({ rlAnswers: { queue: [] as string[] } }));

const mockRl = {
  question: vi.fn((_prompt: string, cb: (a: string) => void) => {
    cb(rlAnswers.queue.shift() ?? '');
  }),
  close: vi.fn(),
  _writeToOutput: undefined as unknown,
};

vi.mock('readline', () => ({
  createInterface: vi.fn(() => mockRl),
}));

// ── llm-connection-check mock ─────────────────────────────────────────────────
// 由 caller per-test 重设 mock 行为
const { connMock } = vi.hoisted(() => ({
  connMock: {
    checkLLMConnection: vi.fn(),
    promptReconfigure: vi.fn(),
  },
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  checkLLMConnection: connMock.checkLLMConnection,
  promptReconfigure: connMock.promptReconfigure,
  LLM_ERROR_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error',
    rate_limit: 'Rate limit',
    unknown: 'Unknown',
  },
  classifyLLMError: vi.fn().mockReturnValue('unknown'),
}));

// ── audit log mock ─────────────────────────────────────────────────────────────
const { auditCalls } = vi.hoisted(() => ({ auditCalls: { entries: [] as string[][] } }));
const mockAudit = {
  write: vi.fn((...args: string[]) => {
    auditCalls.entries.push(args);
  }),
} as unknown as import('../../src/foundation/audit/index.js').AuditLog;

let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
    throw new Error(`process.exit(${_code})`);
  });
});

afterEach(() => {
  processExitSpy.mockRestore();
});

const { initCommand } = await import('../../src/cli/commands/init.js');
const { loadGlobalConfig } = await import('../../src/foundation/config/index.js');
const { CONFIG_DEFAULTS } = await import('../../src/assembly/config-defaults.js');

let tempDir: string;

function setupTempDir() {
  tempDir = path.join(tmpdir(), `clawforum-init-probe-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CLAWFORUM_ROOT', tempDir);
}

function teardownTempDir() {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

describe('initCommand — probe success path', () => {
  beforeEach(() => {
    setupTempDir();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
    rlAnswers.queue = [];
    auditCalls.entries = [];
    connMock.checkLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('probe succeeds → config saved + INIT_PROBE_SUCCEEDED audit', async () => {
    connMock.checkLLMConnection.mockResolvedValue({ ok: true, model: 'claude-test' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['1', '1', '']; // branch 1, pick 1, model=auto

    await initCommand({ fsFactory }, true, { audit: mockAudit });

    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.preset).toBe('anthropic');

    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_attempted');
    expect(eventTypes).toContain('cli_init_probe_succeeded');
    expect(eventTypes).toContain('cli_init_done');
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();
  });
});

describe('initCommand — probe failure: auth → reconfigure success', () => {
  beforeEach(() => {
    setupTempDir();
    mockRl.question.mockClear();
    rlAnswers.queue = [];
    auditCalls.entries = [];
    connMock.checkLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('auth error → promptReconfigure invoked → user fixes → INIT_PROBE_RECONFIGURED', async () => {
    connMock.checkLLMConnection.mockResolvedValue({ ok: false, errorType: 'auth', message: '401 Unauthorized' });
    connMock.promptReconfigure.mockResolvedValue(true);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-bad');
    rlAnswers.queue = ['1', '1', ''];

    await initCommand({ fsFactory }, true, { audit: mockAudit });

    expect(connMock.promptReconfigure).toHaveBeenCalledOnce();
    expect(connMock.promptReconfigure).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'auth',
    );

    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_failed');
    expect(eventTypes).toContain('cli_init_probe_reconfigured');
    expect(eventTypes).toContain('cli_init_done');

    const failEntry = auditCalls.entries.find(e => e[0] === 'cli_init_probe_failed');
    expect(failEntry?.some(s => s.includes('auth'))).toBe(true);
  });
});

describe('initCommand — probe failure: auth → user exits reconfigure', () => {
  beforeEach(() => {
    setupTempDir();
    rlAnswers.queue = [];
    auditCalls.entries = [];
    connMock.checkLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('user exits reconfigure → INIT_PROBE_SKIPPED + config still saved', async () => {
    connMock.checkLLMConnection.mockResolvedValue({ ok: false, errorType: 'model', message: '404 model not found' });
    connMock.promptReconfigure.mockResolvedValue(false); // user picks 'n' exit
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['1', '1', 'bogus-model'];

    await initCommand({ fsFactory }, true, { audit: mockAudit });

    // config still saved (user can fix later)
    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.model).toBe('bogus-model');

    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_failed');
    expect(eventTypes).toContain('cli_init_probe_skipped');

    const skipEntry = auditCalls.entries.find(e => e[0] === 'cli_init_probe_skipped');
    expect(skipEntry?.some(s => s.includes('user_exit_reconfigure'))).toBe(true);
  });
});

describe('initCommand — probe failure: network → warn but continue', () => {
  beforeEach(() => {
    setupTempDir();
    rlAnswers.queue = [];
    auditCalls.entries = [];
    connMock.checkLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('network error → no reconfigure prompt + INIT_PROBE_SKIPPED(transient_network)', async () => {
    connMock.checkLLMConnection.mockResolvedValue({ ok: false, errorType: 'network', message: 'ECONNREFUSED' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['1', '1', ''];

    await initCommand({ fsFactory }, true, { audit: mockAudit });

    expect(connMock.promptReconfigure).not.toHaveBeenCalled();

    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_failed');
    expect(eventTypes).toContain('cli_init_probe_skipped');

    const skipEntry = auditCalls.entries.find(e => e[0] === 'cli_init_probe_skipped');
    expect(skipEntry?.some(s => s.includes('transient_network'))).toBe(true);
  });
});

describe('initCommand — probe failure: error message truncation', () => {
  beforeEach(() => {
    setupTempDir();
    rlAnswers.queue = [];
    auditCalls.entries = [];
    connMock.checkLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('long error message → audit entry truncated to 200 chars', async () => {
    const longMsg = 'X'.repeat(500);
    connMock.checkLLMConnection.mockResolvedValue({ ok: false, errorType: 'network', message: longMsg });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['1', '1', ''];

    await initCommand({ fsFactory }, true, { audit: mockAudit });

    const failEntry = auditCalls.entries.find(e => e[0] === 'cli_init_probe_failed');
    const msgField = failEntry?.find(s => s.startsWith('message='));
    expect(msgField).toBeDefined();
    // 'message=' prefix + 200 chars max
    expect((msgField as string).length).toBeLessThanOrEqual('message='.length + 200);
  });
});
