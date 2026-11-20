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
import { llmProviderCall } from '../../src/foundation/llm-provider/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';
import { createLLMConfiguration } from '../../src/core/llm-configuration/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const commandDeps = {
  fsFactory,
  rootConfig: createRootConfig({ fsFactory }),
  llmConfiguration: createLLMConfiguration({ fsFactory }),
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
  summarizeLLMFailure: (probe: { errorType: string; message: string; provider?: string }) => ({
    ...probe,
    repairActions: ['retry', 'edit-key', 'edit-model', 'edit-provider', 'cancel'],
  }),
  LLM_REPAIR_ACTIONS: ['retry', 'edit-key', 'edit-model', 'edit-provider', 'cancel'],
  LLM_ERROR_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error',
    rate_limit: 'Rate limit',
    quota: 'Account quota or credit exhausted',
    unknown: 'Unrecognized provider error',
  },
  LLM_ERROR_HINTS: {},
  classifyLLMErrorForDisplay: vi.fn().mockReturnValue('unknown'),
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
  connMock.probeLLMConnection.mockImplementation((snapshot: { config: { primary: unknown } }) =>
    connMock.checkLLMConnectionFor(snapshot.config.primary));
  connMock.checkLLMConnection.mockReset();
  connMock.checkLLMConnectionFor.mockReset();
  connMock.promptReconfigure.mockReset();
  loginMock.runProviderLogin.mockReset().mockResolvedValue(undefined);
  loginMock.runProviderLogout.mockReset().mockResolvedValue(undefined);
  loginMock.providerLoginTypes.mockReset();
});

const originalIsTTY = process.stdin.isTTY;

afterEach(() => {
  teardownTempDir();
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
});

/* ── missingStartLLMParams：profile 驱动的缺参规则 ─────────────────────────── */

describe('missingStartLLMParams — Phase 1926 Step D profile 规则', () => {
  it('api_key profile：缺 key 仍报缺参（back-compat）', () => {
    expect(missingStartLLMParams({ provider: 'anthropic', nonInteractive: true }))
      .toEqual(['--api-key-env (or env CHESTNUT_LLM_API_KEY)']);
  });

  it('legacy ambient/OAuth/catalog ids 不再作为正常 setup 方法', () => {
    for (const provider of ['amazon-bedrock', 'openai-codex', 'google-vertex']) {
      expect(() => missingStartLLMParams({ provider, nonInteractive: true }))
        .toThrow(/Unknown configuration method/);
    }
  });

  it('custom 方法要求显式 protocol/base URL/model', () => {
    const missing = missingStartLLMParams({
      provider: 'other', apiKeyEnv: 'MY_KEY', nonInteractive: true,
    });
    expect(missing).toEqual([
      '--api-format (required for custom provider)',
      '--base-url (required for custom provider)',
      '--model (required for custom provider)',
    ]);
  });

});

/* ── config provider login / logout ────────────────────────────────────────── */

function writeCodexConfig() {
  const configDir = path.join(tempDir, '.chestnut');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    `llm:\n  primary:\n    preset: openai-codex\n    model: gpt-6.1-sol\n`,
  );
}

describe('config provider login/logout — Phase 1926 Step D', () => {
  it('login：label → piAiProvider，缺省 type 取 provider 首选（oauth）', async () => {
    writeCodexConfig();
    loginMock.providerLoginTypes.mockResolvedValue(['oauth']);

    const cmd = createConfigCommand(commandDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'login', 'openai-codex']);

    expect(loginMock.providerLoginTypes).toHaveBeenCalledWith('openai-codex');
    expect(loginMock.runProviderLogin).toHaveBeenCalledWith({
      piAiProvider: 'openai-codex', type: 'oauth', authentication: expect.anything(),
    });
  });

  it('login --type api-key：显式选择且 provider 支持时放行', async () => {
    writeCodexConfig();
    loginMock.providerLoginTypes.mockResolvedValue(['oauth', 'api_key']);

    const cmd = createConfigCommand(commandDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'login', 'openai-codex', '--type', 'api-key']);

    expect(loginMock.runProviderLogin).toHaveBeenCalledWith({
      piAiProvider: 'openai-codex', type: 'api_key', authentication: expect.anything(),
    });
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
    expect(loginMock.runProviderLogout).toHaveBeenCalledWith({
      piAiProvider: 'openai-codex', authentication: expect.anything(),
    });
  });
});

// Phase 2207: ambient/OAuth 旧文档仍由 migration/login 支持，但不进入统一 setup 方法目录。
