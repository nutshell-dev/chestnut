/**
 * Phase 81 — init.ts API Key 配置测试
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

// phase 1470: init now probes LLM after save. Stub to always succeed so existing
// branch tests don't hit network. Plain async fns survive vi.restoreAllMocks below.
vi.mock('../../src/cli/llm-connection-check.js', () => ({
  checkLLMConnection: async () => ({ ok: true, model: 'mock-model' }),
  promptReconfigure: async () => true,
  LLM_ERROR_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error',
    rate_limit: 'Rate limit',
    unknown: 'Unknown',
  },
  classifyLLMError: () => 'unknown',
}));

let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
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

// ── helpers ────────────────────────────────────────────────────────────────────

let tempDir: string;

function setupTempDir() {
  tempDir = path.join(tmpdir(), `clawforum-init-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CLAWFORUM_ROOT', tempDir);
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

// ── tests ──────────────────────────────────────────────────────────────────────

describe('initCommand — Branch 1: 扫描环境变量', () => {
  beforeEach(() => {
    setupTempDir();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
    rlAnswers.queue = [];
  });

  afterEach(() => {
    teardownTempDir();
  });

  it('检测到变量 → 选编号 → api_key 存为引用，运行时展开', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-test');
    // configMethod='1', pick='1'(第一个), model=''(→auto)
    rlAnswers.queue = ['1', '1', ''];

    await initCommand({ fsFactory }, true);
    // loadGlobalConfig 在 env var 仍有效时调用，expandEnvVars 展开 ${ANTHROPIC_API_KEY}
    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.api_key).toBe('sk-ant-env-test');
    expect(config.llm.primary.preset).toBe('anthropic');
  });

  it('检测到变量 → 直接输入变量名 → api_key 存为引用，运行时展开', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-test2');
    // configMethod='1', pick='ANTHROPIC_API_KEY', model=''(→auto)
    rlAnswers.queue = ['1', 'ANTHROPIC_API_KEY', ''];

    await initCommand({ fsFactory }, true);
    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.api_key).toBe('sk-ant-env-test2');
  });

  it('未检测到变量 → 输入自定义变量名 → 变量在已知 preset 中 → api_key 存为引用', async () => {
    clearKnownVars();
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-123');
    // configMethod='1', varName='OPENAI_API_KEY', model=''(→auto)
    rlAnswers.queue = ['1', 'OPENAI_API_KEY', ''];

    await initCommand({ fsFactory }, true);
    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.api_key).toBe('sk-openai-123');
    expect(config.llm.primary.preset).toBe('openai');
  });

  it('未检测到变量 → 变量名为空 → throws CliError', async () => {
    clearKnownVars();
    // configMethod='1', varName=''
    rlAnswers.queue = ['1', ''];

    await expect(initCommand({ fsFactory }, true)).rejects.toThrow('Variable name is required');
  });

  it('检测到变量 → 输入无效（非编号非变量名格式）→ throws CliError', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    // configMethod='1', pick='sk-ant-api03-...'（key 格式，不是变量名）
    rlAnswers.queue = ['1', 'sk-ant-api03-invalid'];

    await expect(initCommand({ fsFactory }, true)).rejects.toThrow('Invalid input. Enter a number or a variable name');
  });
});

describe('initCommand — Branch 2: 手动配置', () => {
  beforeEach(() => {
    setupTempDir();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
    rlAnswers.queue = [];
  });

  afterEach(() => {
    teardownTempDir();
  });

  it('选 OpenAI 格式 → 填完整信息 → 写入配置', async () => {
    // configMethod='2', fmt='2'(OpenAI), baseUrl, apiKey, model
    rlAnswers.queue = ['2', '2', 'https://api.openai.com/v1', 'sk-manual', 'gpt-4o'];

    await initCommand({ fsFactory }, true);

    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.preset).toBe('custom-openai');
    expect(config.llm.primary.api_key).toBe('sk-manual');
    expect(config.llm.primary.model).toBe('gpt-4o');
    expect((config.llm.primary as any).base_url).toBe('https://api.openai.com/v1');
  });

  it('选 Anthropic 格式 → 填完整信息 → 写入配置', async () => {
    rlAnswers.queue = ['2', '1', 'https://api.anthropic.com', 'sk-ant-key', 'claude-3-7-sonnet'];

    await initCommand({ fsFactory }, true);

    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.preset).toBe('custom-anthropic');
    expect(config.llm.primary.api_key).toBe('sk-ant-key');
  });

  it('Base URL 为空 → 重新提示，再次输入有效值后继续', async () => {
    // configMethod='2', fmt='2', baseUrl=''(重试), baseUrl=有效值, apiKey, model
    rlAnswers.queue = ['2', '2', '', 'https://api.example.com', 'sk-key', 'my-model'];

    await initCommand({ fsFactory }, true);

    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect((config.llm.primary as any).base_url).toBe('https://api.example.com');
  });

  it('API Key 为空 → 重新提示，再次输入有效值后继续', async () => {
    // configMethod='2', fmt='2', baseUrl, apiKey=''(重试), apiKey=有效值, model
    rlAnswers.queue = ['2', '2', 'https://api.example.com', '', 'sk-retry', 'my-model'];

    await initCommand({ fsFactory }, true);

    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.api_key).toBe('sk-retry');
  });
});

describe('initCommand — Branch 3: 选择 provider', () => {
  beforeEach(() => {
    setupTempDir();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
    rlAnswers.queue = [];
  });

  afterEach(() => {
    teardownTempDir();
  });

  it('选 Anthropic → 手动输入 key → 写入配置', async () => {
    // configMethod='3', provider='1'(Anthropic), apiKey='sk-ant-xxx', model=''(→auto)
    rlAnswers.queue = ['3', '1', 'sk-ant-xxx', ''];

    await initCommand({ fsFactory }, true);

    const config = loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    expect(config.llm.primary.preset).toBe('anthropic');
    expect(config.llm.primary.api_key).toBe('sk-ant-xxx');
    expect(config.llm.primary.model).toBe('auto');
  });
});
