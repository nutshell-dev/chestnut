/**
 * Phase 451 Step A — config provider add probes new config after save.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const configDeps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
};

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
    checkLLMConnection: vi.fn(),
    checkLLMConnectionFor: vi.fn(),
    promptReconfigure: vi.fn(),
  },
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  checkLLMConnection: connMock.checkLLMConnection,
  checkLLMConnectionFor: connMock.checkLLMConnectionFor,
  promptReconfigure: connMock.promptReconfigure,
  formatLLMError: vi.fn().mockReturnValue([]),
  LLM_ERROR_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error',
    rate_limit: 'Rate limit',
    quota: 'Account quota or credit exhausted',
    unknown: 'Unrecognized provider error',
  },
  LLM_ERROR_HINTS: {},
  classifyLLMError: vi.fn().mockReturnValue('unknown'),
}));

// ── notifyRunningDaemons mock (avoid touching real process manager) ────────────
vi.mock('../../src/cli/commands/config.js?notify', () => ({}));

// phase 1247 Step C: config provider commands use action('required'), which calls
// ensureWatchdog at the CLI boundary. These tests focus on provider probing, not
// watchdog lifecycle, so we stub ensureWatchdog to avoid spawning real processes.
vi.mock('../../src/watchdog/ensure.js', () => ({
  ensureWatchdog: vi.fn().mockResolvedValue(undefined),
}));

const { createConfigCommand } = await import('../../src/cli/commands/config.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');

let tempDir: string;

function setupTempDir() {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-config-add-probe-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  // Phase 1925 Step B：凭据层隔离 —— 明文 key 落用户级凭据文件，测试中绝不触碰真实 home
  vi.stubEnv('CHESTNUT_HOME', path.join(tempDir, 'cred-home'));
}

function teardownTempDir() {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function writeInitialConfig() {
  const configDir = path.join(tempDir, '.chestnut');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    `llm:\n  primary:\n    preset: anthropic\n    api_key: sk-ant-old\n`,
  );
}

const originalIsTTY = process.stdin.isTTY;

describe('config provider add — primary probe', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    setupTempDir();
    writeInitialConfig();
    rlAnswers.queue = [];
    connMock.checkLLMConnectionFor.mockReset();
    connMock.promptReconfigure.mockReset();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
  });
  afterEach(() => {
    teardownTempDir();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('adds primary and probes the new primary on success', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'claude-3' });
    // service 8 (Anthropic), label, key, model default, role primary, role confirm, save confirm
    rlAnswers.queue = ['8', 'new-anthropic', 'sk-ant-new', '', '1', 'y', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    const calledWith = connMock.checkLLMConnectionFor.mock.calls[0][0];
    expect(calledWith.apiKey).toBe('sk-ant-new');

    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.api_key).toBe('sk-ant-new');

    // phase 1452 Step B: saveGlobal 成功侧 emit cli_config_saved
    const auditContent = fs.readFileSync(path.join(tempDir, '.chestnut', 'audit.tsv'), 'utf-8');
    expect(auditContent).toContain('cli_config_saved');
    expect(auditContent).toContain('command=provider_add');
    expect(auditContent).toContain('label=new-anthropic');
  });

  it('adds primary, probes fail auth, enters reconfigure', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'anthropic' });
    connMock.promptReconfigure.mockResolvedValue(undefined);
    rlAnswers.queue = ['8', 'new-anthropic', 'sk-ant-new', '', '1', 'y', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    // Phase 1972: probe failure does not commit and does not enter reconfigure.
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.api_key).toBe('sk-ant-old');
  });
});

describe('config provider add — fallback probe', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    setupTempDir();
    writeInitialConfig();
    rlAnswers.queue = [];
    connMock.checkLLMConnectionFor.mockReset();
    connMock.promptReconfigure.mockReset();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
  });
  afterEach(() => {
    teardownTempDir();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('adds fallback and probes it; failure does not block or trigger reconfigure', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'openai' });
    // service 6 (OpenAI), label, key, model default, role fallback, position default, save confirm
    rlAnswers.queue = ['6', 'new-openai', 'sk-openai', '', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();

    // Phase 1972: unverified fallback is not persisted.
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.fallbacks ?? []).toHaveLength(0);
  });
});

describe('config provider add — 多端点候选 probe（Phase 1973）', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    setupTempDir();
    writeInitialConfig();
    rlAnswers.queue = [];
    connMock.checkLLMConnectionFor.mockReset();
    connMock.promptReconfigure.mockReset();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
  });
  afterEach(() => {
    teardownTempDir();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('Kimi 首胜即停：第三候选成功，第四候选未调用，winner baseUrl 落盘', async () => {
    connMock.checkLLMConnectionFor
      .mockResolvedValueOnce({ ok: false, errorType: 'auth', message: '401', provider: 'kimi' })
      .mockResolvedValueOnce({ ok: false, errorType: 'network', message: 'timeout', provider: 'kimi' })
      .mockResolvedValueOnce({ ok: true, model: 'k3-256k' });
    // service 2 (Kimi), label, key, model default, role fallback, position default, save confirm
    rlAnswers.queue = ['2', 'kimi-test', 'sk-kimi-key', '', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(3);
    // 每个候选 probe 使用用户 key（解析后非空）/model + 候选 baseUrl。
    // 注意：本机进程环境可能已设 KIMI_API_KEY（分层解析 env 优先），
    // 故不断言具体 key 值，只断言解析成功且 model 为用户输入。
    for (const call of connMock.checkLLMConnectionFor.mock.calls) {
      expect(typeof call[0].apiKey).toBe('string');
      expect(call[0].apiKey.length).toBeGreaterThan(0);
      expect(call[0].model).toBe('k3-256k');
    }
    expect(connMock.checkLLMConnectionFor.mock.calls.map(c => c[0].baseUrl)).toEqual([
      'https://api.kimi.com/coding',
      'https://api.kimi.ai/coding',
      'https://api.moonshot.cn/anthropic',
    ]);

    // winner baseUrl + preset 落盘（不只看 mock 调用次数）
    const config = loadGlobalConfig({ fsFactory });
    const added = (config.llm.fallbacks ?? []).find(f => f.label === 'kimi-test');
    expect(added).toBeDefined();
    expect(added?.preset).toBe('kimi');
    expect(added?.base_url).toBe('https://api.moonshot.cn/anthropic');
    expect(added?.model).toBe('k3-256k');
  });

  it('Kimi 全败：所有候选 probe 失败时不写入配置', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'kimi' });
    rlAnswers.queue = ['2', 'kimi-test', 'sk-kimi-key', '', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(4);
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some(f => f.label === 'kimi-test')).toBe(false);
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();
  });

  it('Qwen 7 候选首胜：winner baseUrl 落盘，preset 为 qwen', async () => {
    connMock.checkLLMConnectionFor
      .mockResolvedValueOnce({ ok: false, errorType: 'auth', message: '403', provider: 'qwen' })
      .mockResolvedValueOnce({ ok: true, model: 'qwen3.8-max' });
    // service 3 (Qwen), label, key, model default, role fallback, position default, save confirm
    rlAnswers.queue = ['3', 'qwen-test', 'sk-qwen-key', '', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(2);
    const config = loadGlobalConfig({ fsFactory });
    const added = (config.llm.fallbacks ?? []).find(f => f.label === 'qwen-test');
    expect(added?.preset).toBe('qwen');
    expect(added?.base_url).toBe('https://dashscope-intl.aliyuncs.com/apps/anthropic');
    expect(added?.model).toBe('qwen3.8-max');
  });

  it('Qwen 全败：7 个候选全部 probe 且不写入配置', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'model', message: '404', provider: 'qwen' });
    rlAnswers.queue = ['3', 'qwen-test', 'sk-qwen-key', '', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(7);
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some(f => f.label === 'qwen-test')).toBe(false);
  });

  it('非五家（Anthropic）仍只 probe 一次且无候选循环', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'claude-3' });
    // service 8 (Anthropic), label, key, model default, role fallback, position default, save confirm
    rlAnswers.queue = ['8', 'new-anthropic', 'sk-ant-new', '', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    // 非五家不写显式 base_url（走 preset 默认）
    const config = loadGlobalConfig({ fsFactory });
    const added = (config.llm.fallbacks ?? []).find(f => f.label === 'new-anthropic');
    expect(added?.preset).toBe('anthropic');
    expect(added?.base_url).toBeUndefined();
  });
});
