/**
 * Phase 1984 Step C — API Key 输入语义：共享提示 helper、reconfigure key 路径、
 * shadowed_by_env 的 fallback/error 双语义。
 *
 * 契约：
 * - 提示同时说明「回车 = 读环境变量；输入 = 使用输入值」；
 * - env 同名已设置时 typed key 存派生 ref（CHESTNUT_<SEED>_API_KEY），输入值生效；
 * - 派生 ref 仍被 env 遮蔽 → loud CliError（提示 unset），不静默回退；
 * - 缺省 onShadowedEnv 保持原有静默 fallback（空输入用 ${ENV} 路径不经过 store）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createRootConfig } from '../../src/assembly/index.js';
import { createLLMConfiguration } from '../../src/core/llm-configuration/index.js';
import { deriveCredentialRef } from '../../src/core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../../src/core/llm-configuration/setup.js';
import { setupApiKeyPrompt } from '../../src/templates/messages/index.js';
import { storeKeyAsCredential } from '../../src/cli/credentials-prompt.js';

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

// ── orchestrator mock：reconfigure 改完自动 re-probe，避免真实网络 ────────────
vi.mock('../../src/foundation/llm-orchestrator/index.js', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('../../src/foundation/llm-orchestrator/index.js')>();
  return {
    ...orig,
    createLLMOrchestrator: () => ({
      call: vi.fn().mockResolvedValue({ content: 'ok' }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

const { promptReconfigure } = await import('../../src/cli/llm-connection-check.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');

const originalIsTTY = process.stdin.isTTY;

let tempDir: string;

function setupTempDir() {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tempDir = path.join(tmpdir(), `chestnut-cred-env-shadow-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
}

function teardownTempDir() {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function writeInitialConfig(apiKey = '${ANTHROPIC_API_KEY}') {
  const configDir = path.join(tempDir, '.chestnut');
  fs.mkdirSync(path.join(configDir, 'llm'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), '{}\n');
  fs.writeFileSync(
    path.join(configDir, 'llm', 'config.yaml'),
    `schema_version: 1
revision: 1
primary:
  provider_id: custom:anthropic
  api_format: anthropic
  auth_profile: api_key
  label: main
  api_key: ${apiKey}
  model: claude-test
  base_url: https://api.anthropic.com
`,
  );
}

describe('setupApiKeyPrompt — 提示文案（Phase 1984 Step B/C）', () => {
  it('env 可用时同时说明回车与输入两种行为', () => {
    expect(setupApiKeyPrompt('KIMI_API_KEY')).toBe(
      'API Key (Enter = use KIMI_API_KEY from environment; type a value to use it)',
    );
  });

  it('env 不可用时只显示 API Key', () => {
    expect(setupApiKeyPrompt()).toBe('API Key');
    expect(setupApiKeyPrompt(undefined)).toBe('API Key');
  });
});

describe('storeKeyAsCredential — onShadowedEnv 双语义', () => {
  beforeEach(() => setupTempDir());
  afterEach(() => teardownTempDir());

  it('缺省 fallback：env 遮蔽时返回 ${ref} 并提示运行时读环境（行为保持）', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const ref = await storeKeyAsCredential(
        { fsFactory },
        'typed-key',
        { envVar: 'ANTHROPIC_API_KEY', seed: 'anthropic' },
      );
      expect(ref).toBe('${ANTHROPIC_API_KEY}');
      expect(lines.some((l) => l.includes('Will read the API key from the process environment'))).toBe(true);
      expect(lines.join('\n')).not.toContain('ANTHROPIC_API_KEY');
      expect(lines.join('\n')).not.toContain('typed-key');
    } finally {
      logSpy.mockRestore();
    }
  });

  it("onShadowedEnv: 'error'：派生 ref 被遮蔽时 loud CliError，不静默回退", async () => {
    vi.stubEnv('CHESTNUT_ANTHROPIC_API_KEY', 'derived-env-key');
    await expect(
      storeKeyAsCredential(
        { fsFactory },
        'typed-key',
        { seed: 'anthropic', onShadowedEnv: 'error' },
      ),
    ).rejects.toThrow(/Unset the environment variable/);
    await expect(
      storeKeyAsCredential(
        { fsFactory }, 'typed-key', { seed: 'anthropic', onShadowedEnv: 'error' },
      ),
    ).rejects.toThrow(/^(?!.*CHESTNUT_ANTHROPIC_API_KEY).*$/);
    // 不写凭据文件
    expect(fs.existsSync(path.join(tempDir, '.chestnut', 'llm', 'credentials.yaml'))).toBe(false);
  });

  it('派生 ref 未被遮蔽时正常落凭据文件', async () => {
    const ref = await storeKeyAsCredential(
      { fsFactory },
      'typed-key',
      { seed: 'anthropic', onShadowedEnv: 'error' },
    );
    expect(ref).toBe('${CHESTNUT_ANTHROPIC_API_KEY}');
    expect(deriveCredentialRef('anthropic')).toBe('CHESTNUT_ANTHROPIC_API_KEY');
    const authentication = createAuthenticationSetup({ fsFactory });
    expect(authentication.resolveSync('CHESTNUT_ANTHROPIC_API_KEY')?.accessToken).toBe('typed-key');
    expect(ref).not.toContain('typed-key');
  });
});

describe('promptReconfigure — reconfigure key 路径（Phase 1984 Step C）', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    setupTempDir();
    writeInitialConfig();
    rlAnswers.queue = [];
    mockRl.question.mockClear();
    mockRl.close.mockClear();
  });
  afterEach(() => {
    teardownTempDir();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  async function deps() {
    const root = createRootConfig({ fsFactory });
    await root.migrateLLMConfiguration();
    await root.migrateLegacyApiKeys();
    return { fsFactory, llmConfiguration: createLLMConfiguration({ fsFactory }) };
  }

  it('env 已设置 + typed key → 派生 ref，patchPrimary 收到 ${CHESTNUT_<seed>_API_KEY}', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    // menu 2 (Re-enter API key) → new key → probe → return; trailing n prevents loops on failure.
    rlAnswers.queue = ['2', 'typed-key', 'n'];

    const rl = mockRl as unknown as import('readline').Interface;
    const snapshot = await promptReconfigure(await deps(), rl, 'auth');

    expect(snapshot).not.toBeNull();
    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'llm', 'config.yaml'), 'utf8');
    const ref = createLLMConfiguration({ fsFactory }).store.read().primary.api_key;
    expect(ref).toMatch(/^\$\{CHESTNUT_PROVIDER_REPAIR_[A-Z0-9_]+_API_KEY\}$/);
    expect(rawYaml).not.toContain('typed-key');
    expect(loadGlobalConfig({ fsFactory }).llm.primary.api_key).toBe('typed-key');
    const authentication = createAuthenticationSetup({ fsFactory });
    expect(authentication.resolveSync(ref.slice(2, -1))?.accessToken).toBe('typed-key');
  });

  it('env 未设置 + typed key → 显式 custom provider 派生 ref', async () => {
    // 初始配置用明文 key，验证既有 legacy key 迁移后再走 reconfigure。
    writeInitialConfig('sk-ant-old');
    rlAnswers.queue = ['2', 'typed-key', 'n'];

    const rl = mockRl as unknown as import('readline').Interface;
    const snapshot = await promptReconfigure(await deps(), rl, 'auth');

    expect(snapshot).not.toBeNull();
    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'llm', 'config.yaml'), 'utf8');
    expect(createLLMConfiguration({ fsFactory }).store.read().primary.api_key)
      .toMatch(/^\$\{CHESTNUT_PROVIDER_REPAIR_[A-Z0-9_]+_API_KEY\}$/);
    expect(loadGlobalConfig({ fsFactory }).llm.primary.api_key).toBe('typed-key');
  });

  it('旧 env ref 不覆盖新 repair seed，输入值写入独立 ref', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    rlAnswers.queue = ['2', 'typed-key', 'n'];

    const rl = mockRl as unknown as import('readline').Interface;
    await promptReconfigure(await deps(), rl, 'auth');
    const document = createLLMConfiguration({ fsFactory }).store.read();
    expect(document.primary.api_key).not.toBe('${ANTHROPIC_API_KEY}');
    expect(document.primary.api_key).toMatch(/PROVIDER_REPAIR/);
  });

  it.each([
    { kind: 'committed_platform_limited' as const },
    { kind: 'committed_durability_unknown' as const },
  ])('patchPrimary $kind → degraded notice 后继续 probe，不重写', async ({ kind }) => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    const configDeps = await deps();
    const error = Object.assign(new Error(`directory fsync failed: ${kind}`), { code: 'EIO' });
    const store = configDeps.llmConfiguration.store;
    vi.spyOn(configDeps.llmConfiguration, 'store', 'get').mockReturnValue(store);
    const patch = vi.spyOn(store, 'commitExplicitProvider')
      .mockImplementation(async (target, _config, _expectedRevision) => ({
        target,
        revision: { id: '2', revision: 2 },
        write: { kind, error },
        document: { ...configDeps.llmConfiguration.store.read(), revision: 2 },
      }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rlAnswers.queue = ['3', 'claude-new'];

    try {
      const rl = mockRl as unknown as import('readline').Interface;
      const snapshot = await promptReconfigure(configDeps, rl, 'model');

      expect(snapshot).not.toBeNull();
      expect(patch).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`kind=${kind}`));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`directory fsync failed: ${kind}`));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('patchPrimary throw → 保持原失败且不重试', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    const configDeps = await deps();
    const failure = new Error('rename failed');
    const store = configDeps.llmConfiguration.store;
    vi.spyOn(configDeps.llmConfiguration, 'store', 'get').mockReturnValue(store);
    const patch = vi.spyOn(store, 'commitExplicitProvider').mockRejectedValue(failure);
    rlAnswers.queue = ['3', 'claude-new'];

    const rl = mockRl as unknown as import('readline').Interface;
    await expect(promptReconfigure(configDeps, rl, 'model')).rejects.toBe(failure);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('provider replacement 复用 shared editor 并提交显式 catalog facts', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    // Change provider → OpenAI → typed key → Enter accepts the explicit default model.
    rlAnswers.queue = ['4', '6', 'typed-key', ''];
    const rl = mockRl as unknown as import('readline').Interface;

    const snapshot = await promptReconfigure(await deps(), rl, 'auth');

    expect(snapshot).not.toBeNull();
    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'llm', 'config.yaml'), 'utf8');
    expect(rawYaml).toContain('provider_id: openai');
    expect(rawYaml).toContain('api_format: openai-responses');
    expect(rawYaml).toContain('auth_profile: api_key');
    expect(rawYaml).toContain('model: gpt-4o');
    expect(rawYaml).not.toContain('preset:');
    expect(rawYaml).not.toContain('typed-key');
  });

  it('custom provider replacement 保留显式 protocol/base URL/model，取消确认不改 primary', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    const rl = mockRl as unknown as import('readline').Interface;
    rlAnswers.queue = [
      '4', '10', '2', 'https://example.test/v1', 'typed-key', 'custom-model', 'y',
    ];
    const snapshot = await promptReconfigure(await deps(), rl, 'auth');
    expect(snapshot).not.toBeNull();
    let rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'llm', 'config.yaml'), 'utf8');
    expect(rawYaml).toContain('provider_id: custom:openai');
    expect(rawYaml).toContain('api_format: openai');
    expect(rawYaml).toContain('model: custom-model');
    expect(rawYaml).toContain('base_url: https://example.test/v1');
    expect(rawYaml).not.toContain('preset:');

    writeInitialConfig();
    const before = fs.readFileSync(path.join(tempDir, '.chestnut', 'llm', 'config.yaml'), 'utf8');
    const credentialsPath = path.join(tempDir, '.chestnut', 'llm', 'credentials.yaml');
    const credentialsBefore = fs.readFileSync(credentialsPath, 'utf8');
    rlAnswers.queue = [
      '4', '10', '2', 'https://cancelled.test/v1', 'typed-key', 'cancelled-model', 'n',
    ];
    const cancelled = await promptReconfigure(await deps(), rl, 'auth');
    expect(cancelled).toBeNull();
    rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'llm', 'config.yaml'), 'utf8');
    expect(rawYaml).toBe(before);
    expect(fs.readFileSync(credentialsPath, 'utf8')).toBe(credentialsBefore);
  });

  it('model 空输入保持 required，所有 reconfigure 问题都不再宣传 preset default/auto', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      rlAnswers.queue = ['3', '', 'n'];
      const rl = mockRl as unknown as import('readline').Interface;
      const snapshot = await promptReconfigure(await deps(), rl, 'model');
      expect(snapshot).toBeNull();
      expect(lines).toContain('Model is required.');
      const prompts = mockRl.question.mock.calls.map(call => String(call[0])).join('\n');
      expect(prompts).not.toMatch(/preset default|"auto"/);
    } finally {
      logSpy.mockRestore();
    }
  });
});
