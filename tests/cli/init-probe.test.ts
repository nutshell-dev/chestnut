/**
 * Phase 1470 — init.ts LLM API probe + reconfigure failure paths
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const commandDeps = { fsFactory, rootConfig: createRootConfig({ fsFactory }) };

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
// Phase 1926 Step C：init probe 缝改 probeLLMConnection（snapshot 身份协议）；
// promptReconfigure 成功返回已 probe 的快照对象（不再是 boolean）。
const { connMock } = vi.hoisted(() => ({
  connMock: {
    probeLLMConnection: vi.fn(),
    promptReconfigure: vi.fn(),
    // Phase 1973 Step C：init 保存前的多端点候选 probe 走 checkLLMConnectionFor
    checkLLMConnectionFor: vi.fn(),
  },
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  probeLLMConnection: connMock.probeLLMConnection,
  promptReconfigure: connMock.promptReconfigure,
  checkLLMConnectionFor: connMock.checkLLMConnectionFor,
  formatLLMError: vi.fn().mockReturnValue([]),
  LLM_ERROR_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error',
    rate_limit: 'Rate limit',
    quota: 'Account quota or credit exhausted',
    unknown: 'Unrecognized provider error',
  },
  LLM_ERROR_HINTS: {
    model: 'Check that model name matches provider docs exactly.',
  },
  classifyLLMError: vi.fn().mockReturnValue('unknown'),
}));

// ── audit log mock ─────────────────────────────────────────────────────────────
const { auditCalls } = vi.hoisted(() => ({ auditCalls: { entries: [] as string[][] } }));
const mockAudit = {
  __brand: 'AuditLog' as const,
  write: vi.fn((...args: string[]) => {
    auditCalls.entries.push(args);
  }),
  preview: vi.fn((s: string) => s),
  message: vi.fn((s: string) => s),
  summary: vi.fn((s: string) => s),
} as unknown as import('../../src/foundation/audit/index.js').AuditLog;

let processExitSpy: ReturnType<typeof vi.spyOn>;

const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
    throw new Error(`process.exit(${_code})`);
  });
});

afterEach(() => {
  processExitSpy.mockRestore();
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
});

const { initCommand } = await import('../../src/cli/commands/init.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');

let tempDir: string;

function setupTempDir() {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-init-probe-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  vi.stubEnv('CHESTNUT_HOME', path.join(tempDir, 'cred-home'));
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
    connMock.probeLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('probe succeeds → config saved + INIT_PROBE_SUCCEEDED audit', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'claude-test' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['8', '', '', 'y']; // branch 1, pick 1, model=auto

    await initCommand(commandDeps, true, { audit: mockAudit });

    const config = loadGlobalConfig({ fsFactory });
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
    connMock.probeLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('auth error → promptReconfigure invoked → user fixes → INIT_PROBE_RECONFIGURED', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: false, errorType: 'auth', message: '401 Unauthorized' });
    connMock.promptReconfigure.mockResolvedValue({ config: { primary: { model: 'fixed-model' } }, identity: 'fixed-identity' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-bad');
    rlAnswers.queue = ['8', '', '', 'y'];

    await initCommand(commandDeps, true, { audit: mockAudit });

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
    connMock.probeLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('user exits reconfigure → INIT_PROBE_SKIPPED + config still saved', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: false, errorType: 'model', message: '404 model not found' });
    connMock.promptReconfigure.mockResolvedValue(null); // user picks 'n' exit
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['8', '', 'bogus-model', 'y'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    // config still saved (user can fix later)
    const config = loadGlobalConfig({ fsFactory });
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
    connMock.probeLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('network error → no reconfigure prompt + INIT_PROBE_SKIPPED(transient_network)', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: false, errorType: 'network', message: 'ECONNREFUSED' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['8', '', '', 'y'];

    await initCommand(commandDeps, true, { audit: mockAudit });

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
    connMock.probeLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
  });
  afterEach(() => teardownTempDir());

  it('long error message → delegated to audit.message for truncation', async () => {
    const longMsg = 'X'.repeat(500);
    connMock.probeLLMConnection.mockResolvedValue({ ok: false, errorType: 'network', message: longMsg });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['8', '', '', 'y'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(mockAudit.message).toHaveBeenCalledWith(longMsg);
    const failEntry = auditCalls.entries.find(e => e[0] === 'cli_init_probe_failed');
    const msgField = failEntry?.find(s => s.startsWith('message='));
    expect(msgField).toBeDefined();
  });
});

describe('initCommand — 多端点候选 probe（Phase 1973）', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    setupTempDir();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
    rlAnswers.queue = [];
    auditCalls.entries = [];
    connMock.probeLLMConnection.mockReset();
    connMock.promptReconfigure.mockReset();
    connMock.checkLLMConnectionFor.mockReset();
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = savedExitCode;
    teardownTempDir();
  });

  it('保存前端点选择：第二候选胜出 → winner baseUrl 进入 saved config', async () => {
    connMock.checkLLMConnectionFor
      .mockResolvedValueOnce({ ok: false, errorType: 'network', message: 'timeout', provider: 'kimi' })
      .mockResolvedValueOnce({ ok: true, model: 'k3-256k' });
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'k3-256k' });
    // service 2 (Kimi), api key, model default, save confirm
    rlAnswers.queue = ['2', 'sk-kimi-key', '', 'y'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    // 首胜即停：4 候选只 probe 2 个
    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(2);
    expect(connMock.checkLLMConnectionFor.mock.calls.map(c => c[0].baseUrl)).toEqual([
      'https://api.kimi.com/coding',
      'https://api.kimi.ai/coding',
    ]);
    // 候选 probe 使用用户 key（解析后非空）/model。
    // 本机进程环境可能已设 KIMI_API_KEY（分层解析 env 优先），不断言具体 key 值。
    for (const call of connMock.checkLLMConnectionFor.mock.calls) {
      expect(typeof call[0].apiKey).toBe('string');
      expect(call[0].apiKey.length).toBeGreaterThan(0);
      expect(call[0].model).toBe('k3-256k');
    }

    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('kimi');
    expect(config.llm.primary.base_url).toBe('https://api.kimi.ai/coding');
    expect(config.llm.primary.model).toBe('k3-256k');

    // 保存后仍保留 post-save probe（身份验证）
    expect(connMock.probeLLMConnection).toHaveBeenCalledOnce();
    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_succeeded');
  });

  it('全败不保存：4 候选全部失败 → config 文件不存在，exitCode=2', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'kimi' });
    rlAnswers.queue = ['2', 'sk-kimi-key', '', 'y'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(4);
    expect(fs.existsSync(path.join(tempDir, '.chestnut', 'config.yaml'))).toBe(false);
    expect(process.exitCode).toBe(2);
    // 未保存 → 无 post-save probe
    expect(connMock.probeLLMConnection).not.toHaveBeenCalled();
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();
  });

  it('非五家（Anthropic）保持保存后单次 probe 流程', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'claude-test' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['8', '', '', 'y'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(connMock.checkLLMConnectionFor).not.toHaveBeenCalled();
    expect(connMock.probeLLMConnection).toHaveBeenCalledOnce();
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('anthropic');
    expect(config.llm.primary.base_url).toBeUndefined();
  });
});
