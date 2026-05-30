import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// 反向 1：验证 passwordQuestion restore 行为
const { rlAnswers } = vi.hoisted(() => ({ rlAnswers: { queue: [] as string[] } }));

const originalWriteFn = vi.fn();
const mockRl = {
  question: vi.fn((_prompt: string, cb: (a: string) => void) => {
    cb(rlAnswers.queue.shift() ?? '');
  }),
  close: vi.fn(),
  _writeToOutput: originalWriteFn,
};

vi.mock('readline', () => ({
  createInterface: vi.fn(() => mockRl),
}));

// phase 1470: init now probes LLM after save. Stub to no-op so this test focuses
// on password prompt restore behavior, not probe network.
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

describe('passwordQuestion reverse — _writeToOutput restored after password prompt', () => {
  beforeEach(() => {
    setupTempDir();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
    originalWriteFn.mockClear();
    rlAnswers.queue = [];
    mockRl._writeToOutput = originalWriteFn;
  });

  afterEach(() => {
    teardownTempDir();
  });

  it('Branch 2 手动配置：apiKey prompt 后 _writeToOutput 恢复为 original（不是 wrapper）', async () => {
    rlAnswers.queue = ['2', '2', 'https://api.openai.com/v1', 'sk-test', 'gpt-4o'];
    await initCommand({ fsFactory }, true);
    // wrapper 包含 muted 变量，恢复后的 original 不包含
    expect(mockRl._writeToOutput.toString()).not.toContain('muted');
  });

  it('Branch 3 选择 provider：apiKey prompt 后 _writeToOutput 恢复为 original（不是 wrapper）', async () => {
    rlAnswers.queue = ['3', '1', 'sk-ant-xxx', ''];
    await initCommand({ fsFactory }, true);
    expect(mockRl._writeToOutput.toString()).not.toContain('muted');
  });
});
