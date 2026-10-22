/**
 * Phase 1972 — init.ts 固定 12 项服务目录、凭据输入与高级 Other 路径。
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

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  probeLLMConnection: async (snapshot: { config: { primary: { model: string } }; identity: string }) =>
    ({ ok: true, model: snapshot.config.primary.model, identity: snapshot.identity }),
  promptReconfigure: async () => null,
  formatLLMError: () => [],
  LLM_ERROR_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error',
    rate_limit: 'Rate limit',
    quota: 'Account quota or credit exhausted',
    unknown: 'Unrecognized provider error',
  },
  LLM_ERROR_HINTS: {},
  classifyLLMError: () => 'unknown',
}));

let processExitSpy: ReturnType<typeof vi.spyOn>;
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  vi.restoreAllMocks();
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
  tempDir = path.join(tmpdir(), `chestnut-init-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
  vi.stubEnv('CHESTNUT_HOME', path.join(tempDir, 'cred-home'));
}

function teardownTempDir() {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const knownVars = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MINIMAX_API_KEY', 'GEMINI_API_KEY',
  'OLLAMA_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY',
  'DASHSCOPE_API_KEY',
];

function clearKnownVars(): void {
  knownVars.forEach(v => vi.stubEnv(v, undefined as unknown as string));
}

function resetAnswers(next: string[]) {
  rlAnswers.queue = next;
  mockRl.question.mockClear();
  mockRl.close.mockClear();
}

describe('initCommand — 默认配置', () => {
  beforeEach(() => { setupTempDir(); clearKnownVars(); });
  afterEach(teardownTempDir);

  it('生成配置包含默认 circuit_breaker 段', async () => {
    resetAnswers(['1', 'sk-deepseek', '', 'y']);
    await initCommand(commandDeps, true);
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.circuit_breaker).toEqual({ failure_threshold: 3, reset_timeout_ms: 60_000 });
  });

  it('Phase 1289 Step D: root YAML 不再写 watchdog 段', async () => {
    resetAnswers(['1', 'sk-deepseek', '', 'y']);
    await initCommand(commandDeps, true);
    const rootYaml = fs.readFileSync(path.join(tempDir, '.chestnut', 'config.yaml'), 'utf8');
    expect(rootYaml).not.toContain('watchdog');
  });
});

describe('initCommand — 服务目录与凭据', () => {
  beforeEach(() => { setupTempDir(); clearKnownVars(); });
  afterEach(teardownTempDir);

  it('Anthropic：环境变量已设置时按 Enter 使用 ${ANTHROPIC_API_KEY}', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-test');
    // service=8 (Anthropic), key Enter, model Enter, save y
    resetAnswers(['8', '', '', 'y']);
    await initCommand(commandDeps, true);
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('anthropic');
    expect(config.llm.primary.api_key).toBe('sk-ant-env-test');
  });

  it('手动输入 key：落凭据引用并展开', async () => {
    // service=8, key=sk-ant-manual, model Enter, save y
    resetAnswers(['8', 'sk-ant-manual', '', 'y']);
    await initCommand(commandDeps, true);
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.api_key).toBe('sk-ant-manual');
    expect(config.llm.primary.preset).toBe('anthropic');
  });

  it('Ollama：本地服务不索 key', async () => {
    // service=11 (Ollama), model Enter, save y
    resetAnswers(['11', '', 'y']);
    await initCommand(commandDeps, true);
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('ollama');
    expect(config.llm.primary.api_key).toBeUndefined();
  });

  it('Other 高级路径：格式 + baseUrl + key + model', async () => {
    // service=12, format=2 (OpenAI), baseUrl, key, model, save y
    resetAnswers([
      '12', '2', 'https://api.openai.com/v1', 'sk-manual', 'gpt-4o', 'y',
    ]);
    await initCommand(commandDeps, true);
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('custom-openai');
    expect(config.llm.primary.api_key).toBe('sk-manual');
    expect(config.llm.primary.model).toBe('gpt-4o');
    expect(config.llm.primary.base_url).toBe('https://api.openai.com/v1');
  });

  it('预览阶段取消：不写配置', async () => {
    resetAnswers(['8', 'sk-ant-manual', '', 'n']);
    await initCommand(commandDeps, true);
    expect(fs.existsSync(path.join(tempDir, '.chestnut', 'config.yaml'))).toBe(false);
  });

  it('非 TTY 交互输入 key：loud 拒绝，不回显降级', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    resetAnswers(['8', 'sk-ant-manual']);
    await expect(initCommand(commandDeps, true)).rejects.toThrow(/requires a TTY/);
  });
});
