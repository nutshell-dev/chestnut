/**
 * Phase 451 Step A — config provider set-primary probes new primary after save.
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

const { createConfigCommand } = await import('../../src/cli/commands/config.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');

let tempDir: string;

function setupTempDir() {
  tempDir = path.join(tmpdir(), `chestnut-config-set-primary-probe-test-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  vi.stubEnv('CHESTNUT_ROOT', tempDir);
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
    `llm:\n  primary:\n    preset: anthropic\n    api_key: sk-ant-old\n  fallbacks:\n    - preset: openai\n      label: my-openai\n      api_key: sk-openai\n`,
  );
}

describe('config provider set-primary — probe', () => {
  beforeEach(() => {
    setupTempDir();
    writeInitialConfig();
    rlAnswers.queue = [];
    connMock.checkLLMConnection.mockReset();
    connMock.checkLLMConnectionFor.mockReset();
    connMock.promptReconfigure.mockReset();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
  });
  afterEach(() => teardownTempDir());

  it('swaps primary and probes the new primary on success', async () => {
    connMock.checkLLMConnection.mockResolvedValue({ ok: true, model: 'gpt-4o' });
    rlAnswers.queue = ['y'];

    const cmd = createConfigCommand({ fsFactory });
    await cmd.parseAsync(['node', 'test', 'provider', 'set-primary', 'my-openai']);

    expect(connMock.checkLLMConnection).toHaveBeenCalledOnce();

    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.preset).toBe('openai');
    expect(config.llm.fallbacks).toHaveLength(1);
    expect(config.llm.fallbacks![0].preset).toBe('anthropic');
  });

  it('new primary probe fails auth → enters reconfigure', async () => {
    connMock.checkLLMConnection.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'openai' });
    connMock.promptReconfigure.mockResolvedValue(undefined);
    rlAnswers.queue = ['y'];

    const cmd = createConfigCommand({ fsFactory });
    await cmd.parseAsync(['node', 'test', 'provider', 'set-primary', 'my-openai']);

    expect(connMock.checkLLMConnection).toHaveBeenCalledOnce();
    expect(connMock.promptReconfigure).toHaveBeenCalledOnce();
    expect(connMock.promptReconfigure).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'auth',
    );
  });
});
