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

// phase 1247 Step C: config provider commands use action('required'), which calls
// ensureWatchdog at the CLI boundary. These tests focus on provider probing, not
// watchdog lifecycle, so we stub ensureWatchdog to avoid spawning real processes.
vi.mock('../../src/watchdog/ensure.js', () => ({
  ensureWatchdog: vi.fn().mockResolvedValue(undefined),
}));

const { createConfigCommand } = await import('../../src/cli/commands/config.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');

let tempDir: string;

function setupTempDir() {
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
    // service 8 (Anthropic), label, key, model default, role primary, role confirm, save confirm
    rlAnswers.queue = ['8', 'new-anthropic', 'sk-ant-new', '', '1', 'y', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    const calledWith = connMock.checkLLMConnectionFor.mock.calls[0][0];
    expect(calledWith.apiKey).toBe('sk-ant-new');

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
    rlAnswers.queue = ['8', 'new-anthropic', 'sk-ant-new', '', '1', 'y', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    // Phase 1972: probe failure does not commit and does not enter reconfigure.
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.primary.api_key).toBe('sk-ant-old');
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
    // service 6 (OpenAI), label, key, model default, role fallback, position default, save confirm
    rlAnswers.queue = ['6', 'new-openai', 'sk-openai', '', '2', '1', 'y'];

    const cmd = createConfigCommand(configDeps);
    await cmd.parseAsync(['node', 'test', 'provider', 'add']);

    expect(connMock.checkLLMConnectionFor).toHaveBeenCalledOnce();
    expect(connMock.promptReconfigure).not.toHaveBeenCalled();

    // Phase 1972: unverified fallback is not persisted.
    const config = loadGlobalConfig({ fsFactory });
    expect(config.llm.fallbacks ?? []).toHaveLength(0);
  });
});
