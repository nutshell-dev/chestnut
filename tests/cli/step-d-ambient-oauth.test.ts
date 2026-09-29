/**
 * Phase 1926 Step D：CLI ambient / OAuth provider 覆盖。
 *
 * - config provider add：ambient preset（amazon-bedrock）不索 API key、配置不落
 *   api_key 字段、probe 配置不带 apiKey；
 * - config provider login/logout：label → preset.piAiProvider → llm-login 运行缝
 *   （缝被 mock；pi-ai 原生 login 流行为由 pi-ai-auth.test.ts 覆盖）；
 * - start 门控 missingStartLLMParams：api key 仅 api_key profile 必需；base-url
 *   仅 custom preset 必需；
 * - init 向导：ambient preset 跳过 key 步骤；OAuth preset 引导登录（缝 mock）。
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

// ── llm-connection-check mock（全 export 补齐：init/config 两模块共用） ─────────
const { connMock } = vi.hoisted(() => ({
  connMock: {
    probeLLMConnection: vi.fn(),
    checkLLMConnection: vi.fn(),
    checkLLMConnectionFor: vi.fn(),
    promptReconfigure: vi.fn(),
  },
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  probeLLMConnection: connMock.probeLLMConnection,
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

// ── llm-login 运行缝 mock（pi-ai 原生 login 流不进本测试面） ───────────────────
const { loginMock } = vi.hoisted(() => ({
  loginMock: {
    runProviderLogin: vi.fn(),
    runProviderLogout: vi.fn(),
    providerLoginTypes: vi.fn(),
  },
}));

vi.mock('../../src/cli/llm-login.js', () => ({
  runProviderLogin: loginMock.runProviderLogin,
  runProviderLogout: loginMock.runProviderLogout,
  providerLoginTypes: loginMock.providerLoginTypes,
}));

// config provider commands 走 action('required') → ensureWatchdog stub
vi.mock('../../src/watchdog/ensure.js', () => ({
  ensureWatchdog: vi.fn().mockResolvedValue(undefined),
}));

const { createConfigCommand } = await import('../../src/cli/commands/config.js');
const { initCommand } = await import('../../src/cli/commands/init.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');
const { missingStartLLMParams } = await import('../../src/cli/start-llm-gate.js');

let tempDir: string;
let processExitSpy: ReturnType<typeof vi.spyOn>;

function setupTempDir() {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-step-d-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  // Phase 1925 Step B：凭据层隔离 —— 绝不触碰真实 home
  vi.stubEnv('CHESTNUT_HOME', path.join(tempDir, 'cred-home'));
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    throw new Error(`process.exit(${code})`);
  });
}

function teardownTempDir() {
  processExitSpy.mockRestore();
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

beforeEach(() => {
  setupTempDir();
  rlAnswers.queue = [];
  mockRl.question.mockClear();
  mockRl.close.mockClear();
  connMock.probeLLMConnection.mockReset();
  connMock.checkLLMConnection.mockReset();
  connMock.checkLLMConnectionFor.mockReset();
  connMock.promptReconfigure.mockReset();
  loginMock.runProviderLogin.mockReset().mockResolvedValue(undefined);
  loginMock.runProviderLogout.mockReset().mockResolvedValue(undefined);
  loginMock.providerLoginTypes.mockReset();
});

afterEach(() => teardownTempDir());

/* ── missingStartLLMParams：profile 驱动的缺参规则 ─────────────────────────── */

describe('missingStartLLMParams — Phase 1926 Step D profile 规则', () => {
  it('api_key profile：缺 key 仍报缺参（back-compat）', () => {
    expect(missingStartLLMParams({ provider: 'anthropic', nonInteractive: true }))
      .toEqual(['--api-key-env (or env CHESTNUT_LLM_API_KEY)']);
  });

  it('ambient profile（amazon-bedrock）：无 key 无 base-url 即完整', () => {
    expect(missingStartLLMParams({ provider: 'amazon-bedrock', nonInteractive: true })).toEqual([]);
  });

  it('oauth profile（openai-codex）：无 key 即完整（凭证缺失由 probe fail-closed exit 3）', () => {
    expect(missingStartLLMParams({ provider: 'openai-codex', nonInteractive: true })).toEqual([]);
  });

  it('custom preset：base-url 仍必需', () => {
    const missing = missingStartLLMParams({
      provider: 'custom-openai',
      apiKeyEnv: 'MY_KEY',
      nonInteractive: true,
    });
    expect(missing).toEqual(['--base-url (required for this provider)']);
  });

  it('catalog preset（google-vertex）：无默认 baseUrl 也不要求 --base-url', () => {
    expect(missingStartLLMParams({ provider: 'google-vertex', nonInteractive: true })).toEqual([]);
  });
});

/* ── config provider add：ambient preset 无 key 流程 ───────────────────────── */

describe('config provider add — ambient preset（Phase 1926 Step D）', () => {
  beforeEach(() => {
    // provider add 要求已初始化（loadGlobal 既有配置）
    const configDir = path.join(tempDir, '.chestnut');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      `llm:\n  primary:\n    preset: anthropic\n    api_key: sk-ant-old\n`,
    );
  });

  it('amazon-bedrock：不索 API key、配置不落 api_key、probe 配置带 authProfile', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'anthropic.claude-sonnet-4-6' });
    // preset #14 = amazon-bedrock；label 默认；无 key 问题；model 默认；role fallback；position 默认
    rlAnswers.queue = ['14', '', '', '2', ''];

    const cmd = createConfigCommand(commandDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    // 未曾询问 API Key
    const prompts = mockRl.question.mock.calls.map((c) => String(c[0]));
    expect(prompts.some((p) => p.includes('API Key'))).toBe(false);

    // probe 配置：无 apiKey、ambient profile、catalog provider
    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    const probeConfig = connMock.checkLLMConnectionFor.mock.calls[0][0];
    expect(probeConfig.apiKey).toBeUndefined();
    expect(probeConfig.authProfile).toBe('ambient');
    expect(probeConfig.piAiProvider).toBe('amazon-bedrock');
    expect(probeConfig.model).toBe('anthropic.claude-sonnet-4-6');

    // 落盘配置无 api_key 字段
    const config = loadGlobalConfig({ fsFactory });
    const added = (config.llm.fallbacks ?? []).find((f) => f.preset === 'amazon-bedrock');
    expect(added).toBeDefined();
    expect(added!.api_key).toBeUndefined();
  });

  it('api_key preset 仍必索 key（back-compat）', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'claude-3' });
    rlAnswers.queue = ['1', 'second-anthropic', 'sk-ant-x', '', '2', ''];

    const cmd = createConfigCommand(commandDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    const prompts = mockRl.question.mock.calls.map((c) => String(c[0]));
    expect(prompts.some((p) => p.includes('API Key'))).toBe(true);
  });
});

/* ── config provider login / logout ────────────────────────────────────────── */

function writeCodexConfig() {
  const configDir = path.join(tempDir, '.chestnut');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    `llm:\n  primary:\n    preset: openai-codex\n    model: gpt-5.5\n`,
  );
}

describe('config provider login/logout — Phase 1926 Step D', () => {
  it('login：label → piAiProvider，缺省 type 取 provider 首选（oauth）', async () => {
    writeCodexConfig();
    loginMock.providerLoginTypes.mockResolvedValue(['oauth']);

    const cmd = createConfigCommand(commandDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'login', 'openai-codex']);

    expect(loginMock.providerLoginTypes).toHaveBeenCalledWith('openai-codex');
    expect(loginMock.runProviderLogin).toHaveBeenCalledWith({ piAiProvider: 'openai-codex', type: 'oauth' });
  });

  it('login --type api-key：显式选择且 provider 支持时放行', async () => {
    writeCodexConfig();
    loginMock.providerLoginTypes.mockResolvedValue(['oauth', 'api_key']);

    const cmd = createConfigCommand(commandDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'login', 'openai-codex', '--type', 'api-key']);

    expect(loginMock.runProviderLogin).toHaveBeenCalledWith({ piAiProvider: 'openai-codex', type: 'api_key' });
  });

  it('login：未知 label → 用法错误（非零退出）', async () => {
    writeCodexConfig();
    const cmd = createConfigCommand(commandDeps);
    await expect(cmd.parseAsync(['node', 'test', 'provider', 'login', 'nope']))
      .rejects.toThrow(/process\.exit/);
    expect(loginMock.runProviderLogin).not.toHaveBeenCalled();
  });

  it('login：provider 不支持所选 type → 错误且不调登录缝', async () => {
    writeCodexConfig();
    loginMock.providerLoginTypes.mockResolvedValue(['oauth']);
    const cmd = createConfigCommand(commandDeps);
    await expect(cmd.parseAsync(['node', 'test', 'provider', 'login', 'openai-codex', '--type', 'api-key']))
      .rejects.toThrow(/process\.exit/);
    expect(loginMock.runProviderLogin).not.toHaveBeenCalled();
  });

  it('login：custom preset（无 piAiProvider）→ 明确拒绝', async () => {
    const configDir = path.join(tempDir, '.chestnut');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      `llm:\n  primary:\n    preset: custom-openai\n    api_key: sk-x\n    base_url: https://x.local/v1\n`,
    );
    const cmd = createConfigCommand(commandDeps);
    await expect(cmd.parseAsync(['node', 'test', 'provider', 'login', 'custom-openai']))
      .rejects.toThrow(/process\.exit/);
    expect(loginMock.runProviderLogin).not.toHaveBeenCalled();
  });

  it('logout：删除 stored credential（缝调用）', async () => {
    writeCodexConfig();
    const cmd = createConfigCommand(commandDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'logout', 'openai-codex']);
    expect(loginMock.runProviderLogout).toHaveBeenCalledWith({ piAiProvider: 'openai-codex' });
  });
});

/* ── init 向导：ambient 跳 key / OAuth 引导登录 ────────────────────────────── */

describe('init 向导 — ambient / OAuth preset（Phase 1926 Step D）', () => {
  it('ambient（amazon-bedrock）：跳过 API key 步骤，配置无 api_key', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'anthropic.claude-sonnet-4-6', identity: 'id-x' });
    // 菜单 3（select provider）→ #11 amazon-bedrock → model auto
    rlAnswers.queue = ['3', '11', 'auto'];

    await initCommand(commandDeps);

    const prompts = mockRl.question.mock.calls.map((c) => String(c[0]));
    expect(prompts.some((p) => p.includes('API Key'))).toBe(false);
    expect(loginMock.runProviderLogin).not.toHaveBeenCalled();

    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('amazon-bedrock');
    expect(config.llm.primary.api_key).toBeUndefined();
  });

  it('oauth（openai-codex）：配置保存后引导 OAuth 登录（缝调用）', async () => {
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'gpt-5.5', identity: 'id-y' });
    // 菜单 3 → #13 openai-codex → model auto → 登录确认 Y
    rlAnswers.queue = ['3', '13', 'auto', 'Y'];

    await initCommand(commandDeps);

    expect(loginMock.runProviderLogin).toHaveBeenCalledWith(
      expect.objectContaining({ piAiProvider: 'openai-codex', type: 'oauth' }),
    );
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('openai-codex');
    expect(config.llm.primary.api_key).toBeUndefined();
  });

  it('oauth 登录失败：warn 不阻断，probe 仍执行（向导兜底）', async () => {
    loginMock.runProviderLogin.mockRejectedValue(new Error('user cancelled'));
    connMock.probeLLMConnection.mockResolvedValue({ ok: true, model: 'gpt-5.5', identity: 'id-z' });
    rlAnswers.queue = ['3', '13', 'auto', 'Y'];

    await initCommand(commandDeps);

    expect(connMock.probeLLMConnection).toHaveBeenCalled();
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('openai-codex');
  });
});
