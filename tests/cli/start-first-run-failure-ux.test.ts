/**
 * Phase 1976 Step D — start 首次配置失败呈现与恢复矩阵。
 *
 * 锁定：
 * A. 固定服务默认 model 无低信息量 preview；单次 probe 后提交 config + ready；
 * B. 自定义 model / Other 条件性 preview + 确认；取消不 probe 不落盘；
 * C. auth/model/network/rate_limit/quota/unknown 失败统一显示错误类别与修复菜单；
 * D. retry / edit-key / edit-model / edit-provider / cancel 的终态；
 * E. 失败/取消不发布 config/ready，本次新建凭据被清理，secret 不回显；
 * F. startCommand 首次取消 → exit 3，且零 supervision/chat。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { createRootConfig, snapshotLLMConfig } from '../../src/assembly/index.js';
import { CliError } from '../../src/cli/errors.js';
import { START_GATE_EXIT_CODE } from '../../src/cli/start-llm-gate.js';
import { createLocalCredentials } from '../../src/foundation/credentials/index.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

// ── readline mock（答案队列）───────────────────────────────────────────────────
const h = vi.hoisted(() => ({ rlAnswers: { queue: [] as string[] } }));

const mockRl = {
  question: vi.fn((_prompt: string, cb: (a: string) => void) => {
    cb(h.rlAnswers.queue.shift() ?? '');
  }),
  close: vi.fn(),
  _writeToOutput: undefined as unknown,
};

vi.mock('readline', () => ({
  createInterface: vi.fn(() => mockRl),
}));

// ── llm-connection-check mock（probe 队列 + 真实结构摘要形状）────────────────────
type MockProbe =
  | { ok: true; model: string }
  | { ok: false; errorType: string; message: string; provider: string };

const { MOCK_LABELS } = vi.hoisted(() => ({
  MOCK_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error — could not reach provider',
    rate_limit: 'Rate limit exceeded',
    quota: 'Account quota or credit exhausted',
    unknown: 'Unrecognized provider error',
  } as Record<string, string>,
}));

const conn = vi.hoisted(() => ({
  probeQueue: [] as MockProbe[],
  probeCalls: 0,
  probeLLMConnection: vi.fn(),
  checkLLMConnectionFor: vi.fn(async (provider: { model: string }) => ({ ok: true, model: provider.model })),
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  probeLLMConnection: conn.probeLLMConnection,
  checkLLMConnectionFor: conn.checkLLMConnectionFor,
  formatLLMError: (probe: { errorType: string; message: string }) => [
    `✗ ${MOCK_LABELS[probe.errorType] ?? probe.errorType}`,
    `  ${probe.message}`,
  ],
  summarizeLLMFailure: (probe: { errorType: string; message: string; provider?: string }) => ({
    ...probe,
    repairActions: ['retry', 'edit-key', 'edit-model', 'edit-provider', 'cancel'],
  }),
  LLM_REPAIR_ACTIONS: ['retry', 'edit-key', 'edit-model', 'edit-provider', 'cancel'],
  LLM_ERROR_LABELS: MOCK_LABELS,
  LLM_ERROR_HINTS: {},
  classifyLLMError: vi.fn().mockReturnValue('unknown'),
}));

// ── start 下游 mock（取消路径必须零调用）───────────────────────────────────────
const downstream = vi.hoisted(() => ({
  ensureSupervision: vi.fn(async () => {}),
  motionInit: vi.fn(async () => {}),
  chat: vi.fn(async () => {}),
  ensureRunning: vi.fn(async () => ({ kind: 'spawned', pid: 4242 })),
}));

vi.mock('../../src/cli/commands/motion.js', () => ({
  initCommand: downstream.motionInit,
  chatCommand: downstream.chat,
  stopCommand: vi.fn(async () => {}),
  motionOutboxCommand: vi.fn(async () => {}),
}));

vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>();
  return {
    ...actual,
    createProcessManagerForCLI: vi.fn(() => ({
      ensureRunning: downstream.ensureRunning,
      readActiveBusinessFact: vi.fn(() => ({ kind: 'fact_missing', generationId: 'gen-test' })),
    })),
  };
});

// ── audit / output capture ────────────────────────────────────────────────────
const auditEvents = vi.hoisted(() => ({ entries: [] as string[][] }));
const mockAudit = {
  __brand: 'AuditLog' as const,
  write: vi.fn((...args: string[]) => { auditEvents.entries.push(args); }),
  preview: vi.fn((s: string) => s),
  message: vi.fn((s: string) => s),
  summary: vi.fn((s: string) => s),
} as unknown as import('../../src/foundation/audit/index.js').AuditLog;

const { runFirstRunSetup } = await import('../../src/cli/first-run-setup.js');
const { startCommand } = await import('../../src/cli/commands/start.js');
const { loadGlobalConfig } = await import('../../src/assembly/config/config-load.js');

let tmpDir: string;
let savedRoot: string | undefined;
let savedHome: string | undefined;
let output: string[];
const originalIsTTY = process.stdin.isTTY;

function resetRun() {
  h.rlAnswers.queue = [];
  auditEvents.entries = [];
  conn.probeQueue = [];
  conn.probeCalls = 0;
  conn.probeLLMConnection.mockReset();
  conn.probeLLMConnection.mockImplementation(async (snapshot: { config: { primary: { model: string } }; identity: string }) => {
    conn.probeCalls++;
    const next = conn.probeQueue.shift() ?? { ok: true as const, model: snapshot.config.primary.model };
    return next.ok
      ? { ok: true as const, model: next.model, identity: snapshot.identity }
      : { ...next, identity: snapshot.identity };
  });
  output = [];
  mockRl.question.mockClear();
  mockRl.close.mockClear();
}

function makeDeps() {
  return { fsFactory, rootConfig: createRootConfig({ fsFactory }) };
}

function configPath(): string {
  return path.join(tmpDir, '.chestnut', 'config.yaml');
}

function readyPath(): string {
  return path.join(tmpDir, '.chestnut', '.initialized');
}

beforeEach(() => {
  resetRun();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1976-first-run-'));
  savedRoot = process.env.CHESTNUT_ROOT;
  savedHome = process.env.CHESTNUT_HOME;
  process.env.CHESTNUT_ROOT = tmpDir;
  process.env.CHESTNUT_HOME = path.join(tmpDir, 'cred-home');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
  downstream.ensureSupervision.mockClear();
  downstream.motionInit.mockClear();
  downstream.chat.mockClear();
  downstream.ensureRunning.mockClear();
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = savedRoot;
  if (savedHome === undefined) delete process.env.CHESTNUT_HOME;
  else process.env.CHESTNUT_HOME = savedHome;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHESTNUT_LLM_API_KEY;
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('first-run wizard — 展示与提交', () => {
  it('固定服务默认 model：无 preview，单次 probe，提交 config + ready', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    h.rlAnswers.queue = ['8', '', ''];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome.kind).toBe('verified');
    expect(output.join('\n')).not.toContain('Configuration preview');
    expect(conn.probeCalls).toBe(1);
    expect(fs.existsSync(configPath())).toBe(true);
    expect(fs.existsSync(readyPath())).toBe(true);

    const diskSnapshot = snapshotLLMConfig(loadGlobalConfig({ fsFactory }));
    if (outcome.kind === 'verified') {
      expect(outcome.verified.snapshot.identity).toBe(diskSnapshot.identity);
    }
    expect(auditEvents.entries.map(e => e[0])).toContain('cli_init_done');
  });

  it('固定服务自定义 model：条件性 preview + 确认后提交', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    h.rlAnswers.queue = ['8', '', 'custom-model', 'y'];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome.kind).toBe('verified');
    expect(output.join('\n')).toContain('Configuration preview');
    expect(loadGlobalConfig({ fsFactory }).llm.primary.model).toBe('custom-model');
    expect(conn.probeCalls).toBe(1);
  });

  it('自定义 model 确认取消 → 零 probe、零落盘', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    h.rlAnswers.queue = ['8', '', 'custom-model', 'n'];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome).toEqual({ kind: 'cancelled', reason: 'user_cancelled' });
    expect(conn.probeCalls).toBe(0);
    expect(fs.existsSync(configPath())).toBe(false);
    expect(fs.existsSync(readyPath())).toBe(false);
    expect(output.join('\n')).toContain('Configuration preview');
  });

  it('Other 服务：条件确认取消 → 零 probe、零落盘', async () => {
    h.rlAnswers.queue = ['12', '2', 'https://example.test/v1', 'sk-other', 'gpt-x', 'n'];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome).toEqual({ kind: 'cancelled', reason: 'user_cancelled' });
    expect(conn.probeCalls).toBe(0);
    expect(fs.existsSync(configPath())).toBe(false);
    expect(output.join('\n')).toContain('Configuration preview');
    expect(output.join('\n')).not.toContain('sk-other');
  });
});

describe('first-run wizard — 失败矩阵与恢复动作', () => {
  const ERROR_TYPES = ['auth', 'model', 'network', 'rate_limit', 'quota', 'unknown'] as const;

  it('auth/model/network/rate_limit/quota/unknown：错误类别 + 修复菜单；取消不落盘', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    for (const errorType of ERROR_TYPES) {
      resetRun();
      conn.probeQueue = [{ ok: false, errorType, message: `fail-${errorType}`, provider: 'anthropic' }];
      h.rlAnswers.queue = ['8', '', '', 'n'];

      const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

      expect(outcome).toEqual({ kind: 'cancelled', reason: 'user_cancelled' });
      expect(conn.probeCalls).toBe(1);
      expect(fs.existsSync(configPath())).toBe(false);
      expect(fs.existsSync(readyPath())).toBe(false);
      const text = output.join('\n');
      expect(text).toContain(MOCK_LABELS[errorType]);
      expect(text).toContain('Retry connection');
      expect(text).toContain('Re-enter API key');
      expect(text).toContain('Change model');
      expect(text).toContain('Change service');
      expect(text).toContain('Cancel start');
      expect(auditEvents.entries.map(e => e[0])).toContain('cli_init_probe_failed');
    }
  });

  it('retry：失败后重试成功 → 提交', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    conn.probeQueue = [
      { ok: false, errorType: 'network', message: 'ECONNREFUSED', provider: 'anthropic' },
      { ok: true, model: 'claude-tested' },
    ];
    h.rlAnswers.queue = ['8', '', '', '1'];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome.kind).toBe('verified');
    expect(conn.probeCalls).toBe(2);
    expect(fs.existsSync(configPath())).toBe(true);
  });

  it('edit-key：no env 场景重输 key 后成功；secret 不回显', async () => {
    conn.probeQueue = [
      { ok: false, errorType: 'auth', message: '401 bad key', provider: 'anthropic' },
      { ok: true, model: 'claude-ok' },
    ];
    h.rlAnswers.queue = ['8', 'sk-bad-key', '', '2', 'sk-good-key'];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome.kind).toBe('verified');
    expect(conn.probeCalls).toBe(2);
    // 配置只存 ${REF}；load 时展开为用户级凭据值
    const rawYaml = fs.readFileSync(configPath(), 'utf8');
    expect(rawYaml).toContain('${ANTHROPIC_API_KEY}');
    expect(rawYaml).not.toContain('sk-good-key');
    expect(loadGlobalConfig({ fsFactory }).llm.primary.api_key).toBe('sk-good-key');
    expect(output.join('\n')).not.toContain('sk-bad-key');
    expect(output.join('\n')).not.toContain('sk-good-key');
    expect(auditEvents.entries.map(e => e[0])).toContain('cli_init_probe_reconfigured');
  });

  it('edit-model：改 model 后成功 → committed config 使用新 model', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    conn.probeQueue = [
      { ok: false, errorType: 'model', message: '404 model not found', provider: 'anthropic' },
      { ok: true, model: 'fixed-model' },
    ];
    h.rlAnswers.queue = ['8', '', '', '3', 'fixed-model'];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome.kind).toBe('verified');
    expect(loadGlobalConfig({ fsFactory }).llm.primary.model).toBe('fixed-model');
    expect(conn.probeCalls).toBe(2);
  });

  it('edit-provider：换服务后成功 → committed config 使用新 preset', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    conn.probeQueue = [
      { ok: false, errorType: 'auth', message: '401', provider: 'anthropic' },
      { ok: true, model: 'gpt-4o' },
    ];
    h.rlAnswers.queue = ['8', '', '', '4', '6', 'sk-openai-key', ''];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome.kind).toBe('verified');
    expect(loadGlobalConfig({ fsFactory }).llm.primary.preset).toBe('openai');
    expect(conn.probeCalls).toBe(2);
  });

  it('取消时清理本次新建的未绑定凭据', async () => {
    conn.probeQueue = [
      { ok: false, errorType: 'auth', message: '401', provider: 'anthropic' },
    ];
    h.rlAnswers.queue = ['8', 'sk-secret-value', '', 'n'];

    const outcome = await runFirstRunSetup(makeDeps(), { audit: mockAudit });

    expect(outcome.kind).toBe('cancelled');
    const credentials = createLocalCredentials({ fsFactory });
    expect(credentials.resolve('ANTHROPIC_API_KEY')).toBeUndefined();
    expect(output.join('\n')).toContain('Discarded unused credential');
    expect(output.join('\n')).not.toContain('sk-secret-value');
  });
});

describe('start command — 首次取消接线', () => {
  it('首次向导取消 → CliError code=3，零 supervision/chat、零落盘', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    conn.probeQueue = [
      { ok: false, errorType: 'auth', message: '401', provider: 'anthropic' },
    ];
    h.rlAnswers.queue = ['8', '', '', 'n'];

    const err = await startCommand(makeDeps(), {
      audit: mockAudit,
      ensureSupervision: downstream.ensureSupervision,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_GATE_EXIT_CODE);
    expect(downstream.ensureSupervision).not.toHaveBeenCalled();
    expect(downstream.motionInit).not.toHaveBeenCalled();
    expect(downstream.chat).not.toHaveBeenCalled();
    expect(fs.existsSync(configPath())).toBe(false);
    expect(fs.existsSync(readyPath())).toBe(false);
  });
});
