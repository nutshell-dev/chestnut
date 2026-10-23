/**
 * Phase 1470 / 1976 — init 首次配置向导：draft → probe → 修复 → 成功提交。
 *
 * 失败/取消不发布 root config 与 ready；auth/model/network 等失败统一留在
 * 单一修复菜单（retry / edit-key / edit-model / edit-provider / cancel）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';
import { createLocalCredentials } from '../../src/foundation/credentials/index.js';

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
const { connMock } = vi.hoisted(() => ({
  connMock: {
    probeLLMConnection: vi.fn(),
    // Phase 1973 Step C：setup 多端点候选 probe 走 checkLLMConnectionFor
    checkLLMConnectionFor: vi.fn(),
  },
}));

const MOCK_LABELS: Record<string, string> = {
  auth: 'API key invalid or unauthorized',
  model: 'Model not found or unavailable',
  network: 'Network error',
  rate_limit: 'Rate limit',
  quota: 'Account quota or credit exhausted',
  unknown: 'Unrecognized provider error',
};

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  probeLLMConnection: connMock.probeLLMConnection,
  checkLLMConnectionFor: connMock.checkLLMConnectionFor,
  formatLLMError: (probe: { errorType: string; message: string }) => [
    `✗ ${MOCK_LABELS[probe.errorType] ?? probe.errorType}`,
    `  ${probe.message}`,
  ],
  summarizeLLMFailure: (probe: { errorType: string; message: string; provider?: string }) => ({
    ...probe,
    repairActions: ['retry', 'edit-key', 'edit-model', 'edit-provider', 'cancel'],
  }),
  LLM_REPAIR_ACTIONS: ['retry', 'edit-key', 'edit-model', 'edit-provider', 'cancel'],
  LLM_ERROR_LABELS: MOCK_LABELS,
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

function resetProbeMocks() {
  rlAnswers.queue = [];
  auditCalls.entries = [];
  connMock.probeLLMConnection.mockReset();
  connMock.checkLLMConnectionFor.mockReset();
}

describe('initCommand — probe success path', () => {
  beforeEach(() => {
    setupTempDir();
    resetProbeMocks();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
  });
  afterEach(() => teardownTempDir());

  it('固定服务默认 model → 单次 probe → config + ready 提交', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'claude-test' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['8', '', ''];

    await initCommand(commandDeps, true, { audit: mockAudit });

    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('anthropic');

    expect(connMock.probeLLMConnection).toHaveBeenCalledOnce();
    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_attempted');
    expect(eventTypes).toContain('cli_init_probe_succeeded');
    expect(eventTypes).toContain('cli_init_done');
    expect(fs.existsSync(path.join(tempDir, '.chestnut', '.initialized'))).toBe(true);
  });
});

describe('initCommand — 失败后留在向导内修复', () => {
  beforeEach(() => {
    setupTempDir();
    resetProbeMocks();
  });
  afterEach(() => teardownTempDir());

  it('auth 失败 → 重输 key 成功 → INIT_PROBE_RECONFIGURED + 提交', async () => {
    connMock.probeLLMConnection
      .mockResolvedValueOnce({ ok: false, errorType: 'auth', message: '401 Unauthorized' })
      .mockResolvedValue({ ok: true, model: 'claude-test' });
    rlAnswers.queue = ['8', 'sk-ant-bad', '', '2', 'sk-ant-good'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(connMock.probeLLMConnection).toHaveBeenCalledTimes(2);
    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_failed');
    expect(eventTypes).toContain('cli_init_probe_reconfigured');
    expect(eventTypes).toContain('cli_init_probe_succeeded');
    expect(eventTypes).toContain('cli_init_done');

    const failEntry = auditCalls.entries.find(e => e[0] === 'cli_init_probe_failed');
    expect(failEntry?.some(s => s.includes('auth'))).toBe(true);
    // 配置只存 ${REF}，load 时展开为用户级凭据值
    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), 'utf8');
    expect(rawYaml).toContain('${ANTHROPIC_API_KEY}');
    expect(rawYaml).not.toContain('sk-ant-good');
    expect(loadGlobalConfig({ fsFactory }).llm.primary.api_key).toBe('sk-ant-good');
  });

  it('auth 失败 → 用户取消 → 不发布 config/ready，清理本次新建凭据', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: false, errorType: 'auth', message: '401 Unauthorized' });
    rlAnswers.queue = ['8', 'sk-ant-bad', '', 'n'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(fs.existsSync(path.join(tempDir, '.chestnut', 'config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, '.chestnut', '.initialized'))).toBe(false);

    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_failed');
    expect(eventTypes).toContain('cli_init_probe_skipped');
    const skipEntry = auditCalls.entries.find(e => e[0] === 'cli_init_probe_skipped');
    expect(skipEntry?.some(s => s.includes('user_cancel'))).toBe(true);

    const credentials = createLocalCredentials({ fsFactory });
    expect(credentials.resolve('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('network 失败 → retry 成功 → 提交', async () => {
    connMock.probeLLMConnection
      .mockResolvedValueOnce({ ok: false, errorType: 'network', message: 'ECONNREFUSED' })
      .mockResolvedValue({ ok: true, model: 'claude-test' });
    rlAnswers.queue = ['8', 'sk-ant-xxx', '', '1'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(connMock.probeLLMConnection).toHaveBeenCalledTimes(2);
    expect(loadGlobalConfig({ fsFactory }).llm.primary.preset).toBe('anthropic');
    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_succeeded');
    expect(eventTypes).toContain('cli_init_done');
  });

  it('长错误消息 → 经 audit.message 截断', async () => {
    const longMsg = 'X'.repeat(500);
    connMock.probeLLMConnection.mockResolvedValue({ ok: false, errorType: 'network', message: longMsg });
    rlAnswers.queue = ['8', 'sk-ant-xxx', '', 'n'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(mockAudit.message).toHaveBeenCalledWith(longMsg);
    const failEntry = auditCalls.entries.find(e => e[0] === 'cli_init_probe_failed');
    const msgField = failEntry?.find(s => s.startsWith('message='));
    expect(msgField).toBeDefined();
  });
});

describe('initCommand — 多端点候选 probe（Phase 1973 / 1976）', () => {
  beforeEach(() => {
    setupTempDir();
    resetProbeMocks();
  });
  afterEach(() => teardownTempDir());

  it('保存前端点选择：第二候选胜出 → winner baseUrl 进入 committed config', async () => {
    connMock.checkLLMConnectionFor
      .mockResolvedValueOnce({ ok: false, errorType: 'network', message: 'timeout', provider: 'kimi' })
      .mockResolvedValueOnce({ ok: true, model: 'k3-256k' });
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'k3-256k' });
    rlAnswers.queue = ['2', 'sk-kimi-key', ''];

    await initCommand(commandDeps, true, { audit: mockAudit });

    // 首胜即停：4 候选只 probe 2 个
    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(2);
    expect(connMock.checkLLMConnectionFor.mock.calls.map(c => c[0].baseUrl)).toEqual([
      'https://api.kimi.com/coding',
      'https://api.kimi.ai/coding',
    ]);
    for (const call of connMock.checkLLMConnectionFor.mock.calls) {
      expect(typeof call[0].apiKey).toBe('string');
      expect(call[0].apiKey.length).toBeGreaterThan(0);
      expect(call[0].model).toBe('k3-256k');
    }

    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('kimi');
    expect(config.llm.primary.base_url).toBe('https://api.kimi.ai/coding');
    expect(config.llm.primary.model).toBe('k3-256k');

    // 端点选择后仅一次身份 probe（probe-before-commit）
    expect(connMock.probeLLMConnection).toHaveBeenCalledOnce();
    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_succeeded');
  });

  it('全败不保存：候选全失败 → 修复菜单取消 → config 不存在、零身份 probe', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'kimi' });
    rlAnswers.queue = ['2', 'sk-kimi-key', '', 'n'];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(4);
    expect(fs.existsSync(path.join(tempDir, '.chestnut', 'config.yaml'))).toBe(false);
    expect(connMock.probeLLMConnection).not.toHaveBeenCalled();
    const eventTypes = auditCalls.entries.map(e => e[0]);
    expect(eventTypes).toContain('cli_init_probe_failed');
    expect(eventTypes).toContain('cli_init_probe_skipped');
  });

  it('非五家（Anthropic）保持单 endpoint 流程', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'claude-test' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    rlAnswers.queue = ['8', '', ''];

    await initCommand(commandDeps, true, { audit: mockAudit });

    expect(connMock.checkLLMConnectionFor).not.toHaveBeenCalled();
    expect(connMock.probeLLMConnection).toHaveBeenCalledOnce();
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('anthropic');
    expect(config.llm.primary.base_url).toBeUndefined();
  });
});
