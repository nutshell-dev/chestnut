/**
 * Phase 451 Step A — config provider add probes new config after save.
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

// ── notifyRunningDaemons mock (avoid touching real process manager) ────────────
vi.mock('../../src/cli/commands/config.js?notify', () => ({}));

const { createConfigCommand } = await import('../../src/cli/commands/config.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');

let tempDir: string;

function setupTempDir() {
  tempDir = path.join(tmpdir(), `chestnut-config-add-probe-test-${randomUUID()}`);
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
    `llm:\n  primary:\n    preset: anthropic\n    api_key: sk-ant-old\n`,
  );
}

describe('config provider add — primary probe', () => {
  beforeEach(() => {
    setupTempDir();
    writeInitialConfig();
    rlAnswers.queue = [];
    connMock.checkLLMConnectionFor.mockReset();
    connMock.promptReconfigure.mockReset();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
  });
  afterEach(() => teardownTempDir());

  it('adds primary and probes the new primary on success', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: true, model: 'claude-3' });
    // preset #1, custom label, api key, model default, role primary, confirm y
    rlAnswers.queue = ['1', 'new-anthropic', 'sk-ant-new', '', '1', 'y'];

    const cmd = createConfigCommand({ fsFactory });
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    const calledWith = connMock.checkLLMConnectionFor.mock.calls[0][0];
    expect(calledWith.apiKey).toBe('sk-ant-new');

    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.api_key).toBe('sk-ant-new');
  });

  it('adds primary, probes fail auth, enters reconfigure', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'anthropic' });
    connMock.promptReconfigure.mockResolvedValue(undefined);
    rlAnswers.queue = ['1', 'new-anthropic', 'sk-ant-new', '', '1', 'y'];

    const cmd = createConfigCommand({ fsFactory });
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    expect(connMock.promptReconfigure).toHaveBeenCalledOnce();
    expect(connMock.promptReconfigure).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'auth',
    );
  });
});

describe('config provider add — fallback probe', () => {
  beforeEach(() => {
    setupTempDir();
    writeInitialConfig();
    rlAnswers.queue = [];
    connMock.checkLLMConnectionFor.mockReset();
    connMock.promptReconfigure.mockReset();
    mockRl.question.mockClear();
    mockRl.close.mockClear();
  });
  afterEach(() => teardownTempDir());

  it('adds fallback and probes it; failure does not block or trigger reconfigure', async () => {
    connMock.checkLLMConnectionFor.mockResolvedValue({ ok: false, errorType: 'auth', message: '401', provider: 'openai' });
    // preset #1, custom label, api key, model default, role fallback, position 1
    rlAnswers.queue = ['1', 'new-openai', 'sk-openai', '', '2', '1'];

    const cmd = createConfigCommand({ fsFactory });
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();

    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.fallbacks).toHaveLength(1);
    expect(config.llm.fallbacks![0].api_key).toBe('sk-openai');
  });
});
