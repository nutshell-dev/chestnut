/**
 * Phase 1925 Step E — start LLM 验证门控 + 非交互参数。
 *
 * 覆盖（计划 §测试与验收）：
 * A. probe 成功：audit attempted→succeeded 顺序可重建；
 * B. 非交互 probe 失败：CliError code=3、不进 readline、audit aborted(non_interactive)；
 * C. 交互 retry：失败留在向导内，retry 成功后放行；
 * D. 交互 reconfigure：promptReconfigure 成功后放行；
 * E. 交互 cancel：CliError code=3、audit aborted(user_cancel)；
 * F. 指纹漂移：probe 后配置并发改写 → 重验一次，稳定后放行；
 * G. 持续漂移：fail-closed（不猜哪个配置进 chat）；
 * H. 参数校验：配置参数缺 --non-interactive → code=2；
 * I. 非交互首次配置落盘：key 只写 ${VAR} 引用；缺参 → code=2 零落盘；
 * J. start 接线：非交互 probe 失败 → 零 supervision/daemon/onboarding/chat、退出码 3；
 * K. start 接线：非交互首次缺参 → 退出码 2、probe 零次、readline 零次。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { CliError } from '../../src/cli/errors.js';
import {
  START_GATE_EXIT_CODE,
  START_USAGE_EXIT_CODE,
} from '../../src/cli/start-llm-gate.js';

// ── readline mock（答案队列；非交互路径必须零调用）────────────────────────────
const h = vi.hoisted(() => ({
  rlAnswers: { queue: [] as string[] },
  rlCreateCalls: 0,
}));

vi.mock('readline', () => ({
  createInterface: vi.fn(() => {
    h.rlCreateCalls++;
    return {
      question: vi.fn((_prompt: string, cb: (a: string) => void) => {
        cb(h.rlAnswers.queue.shift() ?? '');
      }),
      close: vi.fn(),
    };
  }),
}));

// ── llm-connection-check mock（probe 缝）──────────────────────────────────────
const conn = vi.hoisted(() => ({
  checkLLMConnection: vi.fn(),
  promptReconfigure: vi.fn(),
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  checkLLMConnection: conn.checkLLMConnection,
  promptReconfigure: conn.promptReconfigure,
  formatLLMError: vi.fn((probe: { errorType: string; message: string }) => [
    `✗ ${probe.errorType}`,
    `  ${probe.message}`,
  ]),
  LLM_ERROR_LABELS: {
    auth: 'API key invalid or unauthorized',
    model: 'Model not found or unavailable',
    network: 'Network error',
    rate_limit: 'Rate limit',
    quota: 'Account quota or credit exhausted',
    unknown: 'Unrecognized provider error',
  },
  LLM_ERROR_HINTS: { auth: 'Check API key.' },
  classifyLLMError: vi.fn().mockReturnValue('unknown'),
}));

// ── start 接线测试的下游 mock（全部必须零调用）────────────────────────────────
const downstream = vi.hoisted(() => ({
  init: vi.fn(async () => ({ probeVerified: false })),
  motionInit: vi.fn(async () => {}),
  chat: vi.fn(async () => {}),
  ensureRunning: vi.fn(async () => ({ kind: 'spawned', pid: 4242 })),
}));

vi.mock('../../src/cli/commands/init.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/commands/init.js')>();
  return { ...actual, initCommand: downstream.init };
});

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
    createProcessManagerForCLI: vi.fn(() => ({ ensureRunning: downstream.ensureRunning })),
  };
});

// ── audit mock（事件序列见证）─────────────────────────────────────────────────
const auditRec = vi.hoisted(() => ({ entries: [] as string[][] }));
const mockAudit = {
  __brand: 'AuditLog' as const,
  write: vi.fn((...args: string[]) => { auditRec.entries.push(args); }),
  preview: vi.fn((s: string) => s),
  message: vi.fn((s: string) => s),
  summary: vi.fn((s: string) => s),
} as unknown as import('../../src/foundation/audit/index.js').AuditLog;

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

/** 门控 deps：loadGlobal 每次调用经 primaryOf 取当前 primary（可脚本化漂移）。 */
function makeGateDeps(primaryOf: () => Record<string, unknown>) {
  return {
    fsFactory,
    rootConfig: {
      loadGlobal: vi.fn(() => ({ llm: { primary: primaryOf() } })),
      saveGlobalExclusive: vi.fn(),
      patchPrimary: vi.fn(async () => {}),
      completeInitialization: vi.fn(),
    },
  };
}

const STABLE_PRIMARY = { preset: 'anthropic', api_key: '${ANTHROPIC_API_KEY}', model: 'claude-x' };
const PROBE_FAIL = { ok: false as const, errorType: 'auth' as const, message: 'invalid key', provider: 'anthropic' };
const PROBE_OK = { ok: true as const, model: 'claude-x' };

function auditTypes(): string[] {
  return auditRec.entries.map(e => e[0]);
}

let tmpDir: string;
let savedRoot: string | undefined;

beforeEach(() => {
  h.rlAnswers.queue = [];
  h.rlCreateCalls = 0;
  auditRec.entries = [];
  conn.checkLLMConnection.mockReset();
  conn.promptReconfigure.mockReset();
  downstream.init.mockClear();
  downstream.motionInit.mockClear();
  downstream.chat.mockClear();
  downstream.ensureRunning.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1925-gate-'));
  savedRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = tmpDir;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = savedRoot;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CHESTNUT_LLM_API_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('start LLM gate (unit)', () => {
  it('A. probe 成功：audit attempted→succeeded 顺序可重建', async () => {
    conn.checkLLMConnection.mockResolvedValue(PROBE_OK);
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    await ensureStartLLMVerified(makeGateDeps(() => ({ ...STABLE_PRIMARY })), {
      audit: mockAudit, interactive: true, preVerified: false,
    });

    expect(conn.checkLLMConnection).toHaveBeenCalledTimes(1);
    expect(auditTypes()).toEqual(['cli_start_probe_attempted', 'cli_start_probe_succeeded']);
    expect(h.rlCreateCalls).toBe(0);
  });

  it('A2. preVerified（init 同快照已验）：probe 零次直接放行', async () => {
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    await ensureStartLLMVerified(makeGateDeps(() => ({ ...STABLE_PRIMARY })), {
      audit: mockAudit, interactive: true, preVerified: true,
    });

    expect(conn.checkLLMConnection).not.toHaveBeenCalled();
    expect(auditTypes()).toEqual([]);
  });

  it('B. 非交互 probe 失败：code=3、不进 readline、audit aborted(non_interactive)', async () => {
    conn.checkLLMConnection.mockResolvedValue(PROBE_FAIL);
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const err = await ensureStartLLMVerified(makeGateDeps(() => ({ ...STABLE_PRIMARY })), {
      audit: mockAudit, interactive: false, preVerified: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_GATE_EXIT_CODE);
    expect(h.rlCreateCalls).toBe(0);
    expect(auditTypes()).toEqual([
      'cli_start_probe_attempted',
      'cli_start_probe_failed',
      'cli_start_probe_aborted',
    ]);
    expect(auditRec.entries[2][1]).toBe('reason=non_interactive');
  });

  it('C. 交互 retry：失败留在向导内，retry 成功后放行', async () => {
    conn.checkLLMConnection
      .mockResolvedValueOnce(PROBE_FAIL)
      .mockResolvedValueOnce(PROBE_OK);
    h.rlAnswers.queue = ['1'];
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    await ensureStartLLMVerified(makeGateDeps(() => ({ ...STABLE_PRIMARY })), {
      audit: mockAudit, interactive: true, preVerified: false,
    });

    expect(conn.checkLLMConnection).toHaveBeenCalledTimes(2);
    expect(auditTypes()).toEqual([
      'cli_start_probe_attempted',
      'cli_start_probe_failed',
      'cli_start_probe_succeeded',
    ]);
    expect(auditRec.entries[2][1]).toBe('via=retry');
  });

  it('D. 交互 reconfigure：promptReconfigure 成功后放行', async () => {
    conn.checkLLMConnection.mockResolvedValue(PROBE_FAIL);
    conn.promptReconfigure.mockResolvedValue(true);
    h.rlAnswers.queue = ['2'];
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    await ensureStartLLMVerified(makeGateDeps(() => ({ ...STABLE_PRIMARY })), {
      audit: mockAudit, interactive: true, preVerified: false,
    });

    expect(conn.promptReconfigure).toHaveBeenCalledTimes(1);
    expect(conn.promptReconfigure.mock.calls[0][2]).toBe('auth');
    expect(auditTypes()).toEqual([
      'cli_start_probe_attempted',
      'cli_start_probe_failed',
      'cli_start_probe_succeeded',
    ]);
    expect(auditRec.entries[2][1]).toBe('via=reconfigure');
  });

  it('E. 交互 cancel：code=3、audit aborted(user_cancel)', async () => {
    conn.checkLLMConnection.mockResolvedValue(PROBE_FAIL);
    h.rlAnswers.queue = ['n'];
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const err = await ensureStartLLMVerified(makeGateDeps(() => ({ ...STABLE_PRIMARY })), {
      audit: mockAudit, interactive: true, preVerified: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_GATE_EXIT_CODE);
    expect(auditTypes()).toEqual([
      'cli_start_probe_attempted',
      'cli_start_probe_failed',
      'cli_start_probe_aborted',
    ]);
    expect(auditRec.entries[2][1]).toBe('reason=user_cancel');
  });

  it('F. 指纹漂移：probe 后配置并发改写 → 重验一次，稳定后放行', async () => {
    conn.checkLLMConnection.mockResolvedValue(PROBE_OK);
    // loadGlobal 读序列：验后指纹 a → 收尾比对 b（漂移）→ 重验 c → 收尾 c（稳定）
    const models = ['a', 'b', 'c'];
    const primaryOf = () => ({ ...STABLE_PRIMARY, model: models.shift() ?? 'c' });
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    await ensureStartLLMVerified(makeGateDeps(primaryOf), {
      audit: mockAudit, interactive: true, preVerified: false,
    });

    expect(conn.checkLLMConnection).toHaveBeenCalledTimes(2);
    expect(auditTypes()).toEqual([
      'cli_start_probe_attempted',
      'cli_start_probe_succeeded',
      'cli_start_probe_attempted',
      'cli_start_probe_succeeded',
    ]);
  });

  it('G. 持续漂移：fail-closed（不猜哪个配置进 chat）', async () => {
    conn.checkLLMConnection.mockResolvedValue(PROBE_OK);
    let seq = 0;
    const primaryOf = () => ({ ...STABLE_PRIMARY, model: `m${seq++}` });
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const err = await ensureStartLLMVerified(makeGateDeps(primaryOf), {
      audit: mockAudit, interactive: true, preVerified: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_GATE_EXIT_CODE);
    expect((err as CliError).message).toMatch(/concurrently/);
    // 首验 + 复验各一次 probe，不无限循环
    expect(conn.checkLLMConnection).toHaveBeenCalledTimes(2);
  });

  it('H. 参数校验：配置参数缺 --non-interactive → code=2', async () => {
    const { validateStartLLMOptions } = await import('../../src/cli/start-llm-gate.js');

    const err = (() => {
      try {
        validateStartLLMOptions({ provider: 'anthropic' });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_USAGE_EXIT_CODE);
    // 合法形态不抛
    expect(() => validateStartLLMOptions({})).not.toThrow();
    expect(() => validateStartLLMOptions({ provider: 'anthropic', nonInteractive: true })).not.toThrow();
    expect(() => validateStartLLMOptions({ nonInteractive: true })).not.toThrow();
  });

  it('I. 非交互首次配置落盘：key 只写 ${VAR} 引用；缺参 → code=2 零落盘', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
    const { applyStartLLMOptions } = await import('../../src/cli/start-llm-gate.js');

    // 完整参数：落盘且 api_key 是引用而非明文
    const deps = makeGateDeps(() => ({ ...STABLE_PRIMARY }));
    await applyStartLLMOptions(deps, {
      provider: 'anthropic', model: 'claude-x', apiKeyEnv: 'ANTHROPIC_API_KEY', nonInteractive: true,
    }, 'first-run');
    expect(deps.rootConfig.saveGlobalExclusive).toHaveBeenCalledTimes(1);
    const saved = deps.rootConfig.saveGlobalExclusive.mock.calls[0][0] as {
      llm: { primary: { api_key: string; model: string; preset: string } };
    };
    expect(saved.llm.primary.api_key).toBe('${ANTHROPIC_API_KEY}');
    expect(JSON.stringify(saved)).not.toContain('sk-test-secret');
    expect(deps.rootConfig.completeInitialization).toHaveBeenCalledTimes(1);

    // 缺 key（无 --api-key-env 且无 CHESTNUT_LLM_API_KEY）→ code=2 零落盘
    const deps2 = makeGateDeps(() => ({ ...STABLE_PRIMARY }));
    const err = await applyStartLLMOptions(deps2, {
      provider: 'anthropic', model: 'claude-x', nonInteractive: true,
    }, 'first-run').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_USAGE_EXIT_CODE);
    expect(deps2.rootConfig.saveGlobalExclusive).not.toHaveBeenCalled();
    expect(h.rlCreateCalls).toBe(0);
  });
});

describe('start command gate wiring', () => {
  /** initialized workspace 的 start deps（门控前状态就绪，只欠 LLM 验证）。 */
  function startDeps() {
    return {
      fsFactory,
      rootConfig: {
        isInitialized: () => true,
        loadGlobal: vi.fn(() => ({ llm: { primary: { ...STABLE_PRIMARY } } })),
        saveGlobal: vi.fn(),
        saveGlobalExclusive: vi.fn(),
        patchPrimary: vi.fn(async () => {}),
        getInitializationState: () => 'ready' as const,
        completeInitialization: vi.fn(),
      },
    };
  }

  it('J. 非交互 probe 失败：零 supervision/daemon/onboarding/chat、退出码 3', async () => {
    conn.checkLLMConnection.mockResolvedValue(PROBE_FAIL);
    const { startCommand } = await import('../../src/cli/commands/start.js');
    const ensureSupervision = vi.fn(async () => {});

    const err = await startCommand(startDeps(), { audit: mockAudit, ensureSupervision }, {
      nonInteractive: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_GATE_EXIT_CODE);
    expect((err as CliError).message).toMatch(/chestnut start failed/);
    expect(ensureSupervision).not.toHaveBeenCalled();
    expect(downstream.ensureRunning).not.toHaveBeenCalled();
    expect(downstream.motionInit).not.toHaveBeenCalled();
    expect(downstream.chat).not.toHaveBeenCalled();
    expect(h.rlCreateCalls).toBe(0);
  });

  it('K. 非交互首次缺参：退出码 2、probe 零次、readline 零次、零落盘', async () => {
    const { startCommand } = await import('../../src/cli/commands/start.js');
    const ensureSupervision = vi.fn(async () => {});
    const deps = startDeps();
    deps.rootConfig.isInitialized = () => false;
    deps.rootConfig.getInitializationState = () => 'absent' as const;

    const err = await startCommand(deps, { audit: mockAudit, ensureSupervision }, {
      provider: 'anthropic', nonInteractive: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_USAGE_EXIT_CODE);
    expect(conn.checkLLMConnection).not.toHaveBeenCalled();
    expect(deps.rootConfig.saveGlobalExclusive).not.toHaveBeenCalled();
    expect(ensureSupervision).not.toHaveBeenCalled();
    expect(downstream.init).not.toHaveBeenCalled();
    expect(h.rlCreateCalls).toBe(0);
  });
});
