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
import { createLocalCredentials } from '../../src/foundation/credentials/index.js';
import { setupApiKeyPrompt } from '../../src/templates/messages/index.js';
import {
  storeKeyAsCredential,
  deriveCredentialRef,
} from '../../src/cli/credentials-prompt.js';

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
    createLLMOrchestrator: () => ({ call: vi.fn().mockResolvedValue({ content: 'ok' }) }),
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
  vi.stubEnv('CHESTNUT_HOME', path.join(tempDir, 'cred-home'));
}

function teardownTempDir() {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function writeInitialConfig(apiKey = '${ANTHROPIC_API_KEY}') {
  const configDir = path.join(tempDir, '.chestnut');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    `llm:\n  primary:\n    preset: anthropic\n    api_key: ${apiKey}\n    model: claude-test\n`,
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
      expect(lines.some((l) => l.includes('Will read ANTHROPIC_API_KEY from the process environment'))).toBe(true);
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
    ).rejects.toThrow(/Unset CHESTNUT_ANTHROPIC_API_KEY/);
    // 不写凭据文件
    expect(fs.existsSync(path.join(tempDir, 'cred-home', 'credentials.yaml'))).toBe(false);
  });

  it('派生 ref 未被遮蔽时正常落凭据文件', async () => {
    const ref = await storeKeyAsCredential(
      { fsFactory },
      'typed-key',
      { seed: 'anthropic', onShadowedEnv: 'error' },
    );
    expect(ref).toBe('${CHESTNUT_ANTHROPIC_API_KEY}');
    expect(deriveCredentialRef('anthropic')).toBe('CHESTNUT_ANTHROPIC_API_KEY');
    const credentials = createLocalCredentials({ fsFactory });
    expect(credentials.resolve('CHESTNUT_ANTHROPIC_API_KEY')?.value).toBe('typed-key');
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

  function deps() {
    return { fsFactory, rootConfig: createRootConfig({ fsFactory }) };
  }

  it('env 已设置 + typed key → 派生 ref，patchPrimary 收到 ${CHESTNUT_<seed>_API_KEY}', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    // menu 1 (Update API key) → new key → 自动 re-probe（orchestrator mock ok）→ 返回；
    // 末尾 'n' 兜底：probe 意外失败时退出循环，而不是空队列无限 'Invalid choice.'
    rlAnswers.queue = ['1', 'typed-key', 'n'];

    const rl = mockRl as unknown as import('readline').Interface;
    const snapshot = await promptReconfigure(deps(), rl, 'auth');

    expect(snapshot).not.toBeNull();
    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), 'utf8');
    expect(rawYaml).toContain('${CHESTNUT_ANTHROPIC_API_KEY}');
    expect(rawYaml).not.toContain('typed-key');
    // 加载后 key = 用户输入值（env 不遮蔽派生 ref）
    expect(loadGlobalConfig({ fsFactory }).llm.primary.api_key).toBe('typed-key');
    const credentials = createLocalCredentials({ fsFactory });
    expect(credentials.resolve('CHESTNUT_ANTHROPIC_API_KEY')?.value).toBe('typed-key');
  });

  it('env 未设置 + typed key → 原 envVar ref（行为保持）', async () => {
    // 初始配置用明文 key，避免 ${ANTHROPIC_API_KEY} 在 env 缺席时 loadGlobal 失败
    fs.writeFileSync(
      path.join(tempDir, '.chestnut', 'config.yaml'),
      'llm:\n  primary:\n    preset: anthropic\n    api_key: sk-ant-old\n    model: claude-test\n',
    );
    rlAnswers.queue = ['1', 'typed-key', 'n'];

    const rl = mockRl as unknown as import('readline').Interface;
    const snapshot = await promptReconfigure(deps(), rl, 'auth');

    expect(snapshot).not.toBeNull();
    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), 'utf8');
    expect(rawYaml).toContain('${ANTHROPIC_API_KEY}');
    expect(loadGlobalConfig({ fsFactory }).llm.primary.api_key).toBe('typed-key');
  });

  it('派生 ref 也被 env 遮蔽 → loud CliError，不改配置', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    vi.stubEnv('CHESTNUT_ANTHROPIC_API_KEY', 'derived-env-key');
    rlAnswers.queue = ['1', 'typed-key', 'n'];

    const rl = mockRl as unknown as import('readline').Interface;
    await expect(promptReconfigure(deps(), rl, 'auth')).rejects.toThrow(
      /Unset CHESTNUT_ANTHROPIC_API_KEY/,
    );
    // 配置保持 ${ANTHROPIC_API_KEY} 不被改写
    const rawYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), 'utf8');
    expect(rawYaml).toContain('${ANTHROPIC_API_KEY}');
  });
});
