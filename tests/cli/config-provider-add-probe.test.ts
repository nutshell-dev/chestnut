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
import { clearCliCredentialEnv } from '../helpers/cli-credential-env.js';

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
    // Phase 1980 Step C：暴露 formatLLMError 以断言全败时只调用一次
    formatLLMError: vi.fn((probe: { errorType: string; message: string }) => [
      `ERR:${probe.errorType}:${probe.message}`,
    ]),
  },
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  checkLLMConnection: connMock.checkLLMConnection,
  checkLLMConnectionFor: connMock.checkLLMConnectionFor,
  promptReconfigure: connMock.promptReconfigure,
  formatLLMError: connMock.formatLLMError,
  LLM_ERROR_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error',
    rate_limit: 'Rate limit',
    quota: 'Account quota or credit exhausted',
    unknown: 'Unrecognized provider error',
  },
  LLM_ERROR_HINTS: {
    auth: 'Update API key.',
    model: 'Check model name.',
    unknown: 'See raw message.',
  },
  classifyLLMErrorForDisplay: vi.fn().mockReturnValue('unknown'),
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
const { PRESETS } = await import('../../src/foundation/llm-provider/index.js');

let tempDir: string;

// Phase 1980 Step B：捕获 stdout 以断言 preview/Connecting/确认文案。
let consoleLines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLines = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '));
  });
  connMock.formatLLMError.mockClear();
});
afterEach(() => {
  logSpy.mockRestore();
});

function questionPrompts(): string[] {
  return mockRl.question.mock.calls.map((c) => String(c[0]));
}

function setupTempDir() {
  clearCliCredentialEnv();
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
    // service 8 (Anthropic), label, key, model default, role primary, role confirm
    // Phase 1980 Step B：固定服务无 Save 确认，队列不再带末尾 save 'y'
    rlAnswers.queue = ['8', 'new-anthropic', 'sk-ant-new', '', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    const calledWith = connMock.checkLLMConnectionFor.mock.calls[0][0];
    expect(calledWith.apiKey).toBe('sk-ant-new');

    // Phase 1980 Step B：固定服务无低信息量 preview / Save 确认，只有 Connecting 行
    const out = consoleLines.join('\n');
    expect(out).not.toContain('Configuration preview');
    expect(questionPrompts().some((p) => p.includes('Save this provider?'))).toBe(false);
    expect(out).toContain('Connecting to Anthropic (claude-3-7-sonnet-20250219)...');
    // Phase 1983 Step C：默认值只显示一次（helper 追加，不手写）
    expect(questionPrompts()).toContain('Model [claude-3-7-sonnet-20250219]: ');
    expect(questionPrompts()).toContain('Confirm? [N]: ');
    // Primary 确认包含即将加入的 service/model
    expect(out).toContain('Add Anthropic (claude-3-7-sonnet-20250219) as primary?');
    expect(out).toContain('will become fallback #1.');

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
    rlAnswers.queue = ['8', 'new-anthropic', 'sk-ant-new', '', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    // Phase 1972: probe failure does not commit and does not enter reconfigure.
    // Phase 1980 Step C：单 endpoint 失败保持一次结构化错误/hint
    expect(connMock.formatLLMError).toHaveBeenCalledTimes(1);
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.api_key).toBe('sk-ant-old');
  });

  it('custom model also skips preview/Save and probes directly', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'claude-custom' });
    // service 8 (Anthropic), label, key, custom model, role fallback, position default
    rlAnswers.queue = ['8', 'custom-anthropic', 'sk-ant-new', 'claude-custom', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    // provider add 不再显示完整 preview/Save（固定与自定义一致）
    const out = consoleLines.join('\n');
    expect(out).not.toContain('Configuration preview');
    expect(questionPrompts().some((p) => p.includes('Save this provider?'))).toBe(false);
    expect(out).toContain('Connecting to Anthropic (claude-custom)...');

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some((f) => f.label === 'custom-anthropic')).toBe(true);
  });

  it('Other (custom endpoint) 显示脱敏 preview + 确认，确认后 probe（Phase 1983 Step B）', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'gpt-custom' });
    // service 12 (Other), format 2 (OpenAI), label, key, baseUrl, model, role fallback, position, confirm y
    rlAnswers.queue = ['12', '2', 'other-test', 'sk-other', 'https://example.com/v1', 'gpt-custom', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    const out = consoleLines.join('\n');
    // 自定义配置：与 start/init 同一份脱敏 preview + 同一确认提示
    expect(out).toContain('Configuration preview');
    expect(out).toContain('Base URL: https://example.com/v1');
    expect(out).not.toContain('sk-other');
    expect(questionPrompts().some((p) => p.includes('Continue with this configuration?'))).toBe(true);
    // Phase 1983 Step C：确认默认值由 helper 追加一次
    expect(questionPrompts()).toContain('\nContinue with this configuration? [Y]: ');
    expect(questionPrompts().some((p) => p.includes('Save this provider?'))).toBe(false);
    expect(out).toContain('Connecting to Other (gpt-custom)...');
    expect(out).toContain('Endpoint: https://example.com/v1');

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some((f) => f.label === 'other-test')).toBe(true);
  });

  it('Other 确认取消：零 probe、不落盘（Phase 1983 Step B）', async () => {
    // service 12 (Other), format 2, label, key, baseUrl, model, role fallback, position, confirm n
    rlAnswers.queue = ['12', '2', 'other-test', 'sk-other', 'https://example.com/v1', 'gpt-custom', '2', '1', 'n'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    const out = consoleLines.join('\n');
    expect(out).toContain('Configuration preview');
    expect(out).toContain('Cancelled');
    expect(out).not.toContain('Connecting to');
    expect(connMock.checkLLMConnectionFor).not.toHaveBeenCalled();
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some((f) => f.label === 'other-test')).toBe(false);
  });

  it('Advanced 菜单路径：显示 preview + 确认，确认后 probe（Phase 1983 Step B）', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'claude-3' });
    // service 13 (Advanced), preset anthropic, label, key, model default, role fallback, position, confirm y
    const anthropicNum = String(Object.keys(PRESETS).indexOf('anthropic') + 1);
    rlAnswers.queue = ['13', anthropicNum, 'adv-anthropic', 'sk-ant-adv', '', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    const out = consoleLines.join('\n');
    expect(out).toContain('Configuration preview');
    expect(questionPrompts().some((p) => p.includes('Continue with this configuration?'))).toBe(true);
    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some((f) => f.label === 'adv-anthropic')).toBe(true);
  });
});

describe('config provider add — API Key 输入矩阵（Phase 1984 Step C）', () => {
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

  it('env 已设置 + typed key → 派生 ref 生效，输入值落凭据文件', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'k3-256k' });
    vi.stubEnv('KIMI_API_KEY', 'env-key');
    // service 2 (Kimi), label, key, model default, role fallback, position default
    rlAnswers.queue = ['2', 'kimi-typed', 'typed-key', '', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    // 配置引用派生 ref（seed=label），加载后 = 用户输入值
    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), 'utf8');
    expect(rawYaml).toContain('${CHESTNUT_KIMI_TYPED_API_KEY}');
    expect(rawYaml).not.toContain('${KIMI_API_KEY}');
    const config = loadGlobalConfig({ fsFactory });
    const added = (config.llm.fallbacks ?? []).find(f => f.label === 'kimi-typed');
    expect(added?.api_key).toBe('typed-key');
    // 提示同时说明两种行为
    expect(
      questionPrompts().some(
        (p) => p.includes('Enter = use KIMI_API_KEY') && p.includes('type a value'),
      ),
    ).toBe(true);
  });

  it('env 已设置 + 空输入 → ${ENV}，不写凭据', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'claude-3' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    // service 8 (Anthropic), label, key 空（用 env）, model default, role fallback, position
    rlAnswers.queue = ['8', 'env-anthropic', '', '', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), 'utf8');
    expect(rawYaml).toContain('${ANTHROPIC_API_KEY}');
    const config = loadGlobalConfig({ fsFactory });
    const added = (config.llm.fallbacks ?? []).find(f => f.label === 'env-anthropic');
    expect(added?.api_key).toBe('env-key');
    expect(fs.existsSync(path.join(tempDir, 'cred-home', 'credentials.yaml'))).toBe(false);
  });

  it('派生 ref 也被 env 遮蔽 → loud 失败，不写配置', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'k3-256k' });
    vi.stubEnv('KIMI_API_KEY', 'env-key');
    vi.stubEnv('CHESTNUT_KIMI_TYPED_API_KEY', 'derived-env-key');
    rlAnswers.queue = ['2', 'kimi-typed', 'typed-key', '', '2', '1'];

    // providerAdd 的 CliError 经 withCliErrorHandling → console.error + process.exit(1)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const errLines: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errLines.push(args.map(String).join(' '));
    });
    try {
      const cmd = createConfigCommand(configDeps);
      await expect(cmd.parseAsync(['node', 'test', 'provider', 'add'])).rejects.toThrow(
        'process.exit(1)',
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(errLines.join('\n')).toContain('Unset CHESTNUT_KIMI_TYPED_API_KEY');
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some(f => f.label === 'kimi-typed')).toBe(false);
    expect(connMock.checkLLMConnectionFor).not.toHaveBeenCalled();
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
    // service 6 (OpenAI), label, key, model default, role fallback, position default
    rlAnswers.queue = ['6', 'new-openai', 'sk-openai', '', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    // Phase 1980 Step C：单 endpoint 失败保持一次结构化错误/hint
    expect(connMock.formatLLMError).toHaveBeenCalledTimes(1);
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
    // service 2 (Kimi), label, key, model default, role fallback, position default
    rlAnswers.queue = ['2', 'kimi-test', 'sk-kimi-key', '', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(3);
    // 每个候选 probe 使用用户 key/model + 候选 baseUrl。
    for (const call of connMock.checkLLMConnectionFor.mock.calls) {
      expect(call[0].apiKey).toBe('sk-kimi-key');
      expect(call[0].model).toBe('k3-256k');
    }
    expect(connMock.checkLLMConnectionFor.mock.calls.map(c => c[0].baseUrl)).toEqual([
      'https://api.kimi.com/coding',
      'https://api.kimi.ai/coding',
      'https://api.moonshot.cn/anthropic',
    ]);

    // winner URL 直接显示在 Selected 行（不使用 CN/Intl 标签）
    expect(consoleLines.some((l) => l.includes('Selected: https://api.moonshot.cn/anthropic'))).toBe(true);
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
    rlAnswers.queue = ['2', 'kimi-test', 'sk-kimi-key', '', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(4);
    // Phase 1983 follow-up：全败按错误类别分组摘要，formatLLMError 不再调用
    expect(connMock.formatLLMError).not.toHaveBeenCalled();
    const failedLines = consoleLines.filter((l) => l.startsWith('→ https://') && l.includes('✗'));
    expect(failedLines).toHaveLength(4);
    expect(failedLines[0]).toContain('https://api.kimi.com/coding');
    const out = consoleLines.join('\n');
    expect(out).toContain('✗ All 4 endpoints failed — configuration not saved.');
    expect(out).toContain('API key invalid or unauthorized:');
    expect(out).toContain('  Hint: Update API key.');
    expect(out.split('Hint:').length - 1).toBe(1);
    expect(out).not.toContain('not saved because the connection check failed');
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some(f => f.label === 'kimi-test')).toBe(false);
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();
  });

  it('Qwen 7 候选首胜：winner baseUrl 落盘，preset 为 qwen', async () => {
    connMock.checkLLMConnectionFor
      .mockResolvedValueOnce({ ok: false, errorType: 'auth', message: '403', provider: 'qwen' })
      .mockResolvedValueOnce({ ok: true, model: 'qwen3.8-max' });
    // service 3 (Qwen), label, key, model default, role fallback, position default
    rlAnswers.queue = ['3', 'qwen-test', 'sk-qwen-key', '', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(2);
    expect(consoleLines.some((l) => l.includes('Selected: https://dashscope-intl.aliyuncs.com/apps/anthropic'))).toBe(true);
    const config = loadGlobalConfig({ fsFactory });
    const added = (config.llm.fallbacks ?? []).find(f => f.label === 'qwen-test');
    expect(added?.preset).toBe('qwen');
    expect(added?.base_url).toBe('https://dashscope-intl.aliyuncs.com/apps/anthropic');
    expect(added?.model).toBe('qwen3.8-max');
  });

  it('Qwen 全败：7 个候选全部 probe 且不写入配置', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'model', message: '404', provider: 'qwen' });
    rlAnswers.queue = ['3', 'qwen-test', 'sk-qwen-key', '', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledTimes(7);
    // Phase 1983 follow-up：全败按错误类别分组摘要
    expect(connMock.formatLLMError).not.toHaveBeenCalled();
    const failedLines = consoleLines.filter((l) => l.startsWith('→ https://') && l.includes('✗'));
    expect(failedLines).toHaveLength(7);
    expect(failedLines[0]).toContain('https://dashscope.aliyuncs.com/apps/anthropic');
    const out = consoleLines.join('\n');
    expect(out).toContain('✗ All 7 endpoints failed — configuration not saved.');
    expect(out).toContain('Model not found or unavailable:');
    expect(out).toContain('  Hint: Check model name.');
    expect(out.split('Hint:').length - 1).toBe(1);
    const config = loadGlobalConfig({ fsFactory });
    expect((config.llm.fallbacks ?? []).some(f => f.label === 'qwen-test')).toBe(false);
  });

  it('多端点全败按错误类别分组：不同 endpoint 的不同原因都可见', async () => {
    connMock.checkLLMConnectionFor
      .mockResolvedValueOnce({ ok: false, errorType: 'auth', message: '401', provider: 'kimi' })
      .mockResolvedValueOnce({ ok: false, errorType: 'model', message: '404', provider: 'kimi' })
      .mockResolvedValueOnce({
        ok: false,
        errorType: 'unknown',
        message: '[LLM_ALL_PROVIDERS_FAILED] All LLM providers failed: Qwen (boom)',
        provider: 'kimi',
      })
      .mockResolvedValueOnce({ ok: false, errorType: 'model', message: '404b', provider: 'kimi' });
    rlAnswers.queue = ['2', 'kimi-test', 'sk-kimi-key', '', '2', '1'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    const out = consoleLines.join('\n');
    const authIdx = out.indexOf('API key invalid or unauthorized:');
    const modelIdx = out.indexOf('Model not found or unavailable:');
    const unknownIdx = out.indexOf('Unrecognized provider error:');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThan(authIdx);
    expect(unknownIdx).toBeGreaterThan(modelIdx);
    expect(out).toContain('    https://api.kimi.com/coding');
    expect(out).toContain('    https://api.kimi.ai/coding');
    expect(out).toContain('    https://api.moonshot.cn/anthropic');
    expect(out).toContain('    https://api.moonshot.ai/anthropic');
    // 混合失败只给一条 endpoint/plan hint，不再按错误类别重复
    expect(out.split('Hint:').length - 1).toBe(1);
    expect(out).toContain('Your API key likely matches only one endpoint/plan');
    expect(out).not.toContain('Hint: Update API key.');
    expect(out).not.toContain('Hint: Check model name.');
    expect(out).not.toContain('Hint: See raw message.');
    expect(out).toContain('    boom');
    expect(out).not.toContain('[LLM_ALL_PROVIDERS_FAILED]');
    expect(connMock.formatLLMError).not.toHaveBeenCalled();
  });

  it('非五家（Anthropic）仍只 probe 一次且无候选循环', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'claude-3' });
    // service 8 (Anthropic), label, key, model default, role fallback, position default
    rlAnswers.queue = ['8', 'new-anthropic', 'sk-ant-new', '', '2', '1'];

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
