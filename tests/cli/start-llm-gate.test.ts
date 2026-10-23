/**
 * Phase 1925 Step E — start LLM 验证门控 + 非交互参数。
 * Phase 1926 Step C — 验证身份绑定（LLMConfigSnapshot.identity）。
 *
 * 覆盖（计划 §测试与验收 + 1926 Step A 两个复现场景的修复锁）：
 * A. probe 成功：audit attempted→succeeded 顺序可重建，返回带身份的验证事实；
 * A2. preVerified 身份相等：零 probe 复用；
 * A3. preVerified 身份漂移（stale_init_boolean 修复锁）：全量重验，不零 probe 放行；
 * B. 非交互 probe 失败：CliError code=3、不进 readline、audit aborted(non_interactive)；
 * C. 交互 retry：失败留在向导内，retry 成功后放行；
 * D. 交互 reconfigure：返回快照身份相等 → 放行；
 * E. 交互 cancel：CliError code=3、audit aborted(user_cancel)；
 * F. probe 期间配置漂移（change_during_probe 修复锁）：丢弃结果重验，新配置重新 probe；
 * G. 持续漂移：有界后 fail-closed；
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
import { snapshotLLMConfig } from '../../src/assembly/index.js';
import {
  encodeMotionLLMReadyFact,
  MotionLLMIdentityMismatchError,
} from '../../src/daemon/index.js';
import { ONBOARDING_CONTRACT_ID } from '../../src/core/contract/index.js';

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

// ── llm-connection-check mock（probe 缝；echo snapshot.identity 模拟真实回带）──
const conn = vi.hoisted(() => ({
  probeLLMConnection: vi.fn(),
  promptReconfigure: vi.fn(),
}));

vi.mock('../../src/cli/llm-connection-check.js', () => ({
  probeLLMConnection: conn.probeLLMConnection,
  promptReconfigure: conn.promptReconfigure,
  formatLLMError: vi.fn((probe: { errorType: string; message: string }) => [
    `✗ ${probe.errorType}`,
    `  ${probe.message}`,
  ]),
  summarizeLLMFailure: (probe: { errorType: string; message: string; provider?: string }) => ({
    ...probe,
    repairActions: ['retry', 'edit-key', 'edit-model', 'edit-provider', 'cancel'],
  }),
  LLM_REPAIR_ACTIONS: ['retry', 'edit-key', 'edit-model', 'edit-provider', 'cancel'],
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
  init: vi.fn(async () => ({})),
  motionInit: vi.fn(async () => {}),
  chat: vi.fn(async () => {}),
  ensureRunning: vi.fn(async () => ({ kind: 'spawned', pid: 4242 })),
  // Phase 1927 Step C：ready 业务事实读取缝（默认实现见 beforeEach）
  readBusinessFact: vi.fn(),
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
    createProcessManagerForCLI: vi.fn(() => ({
      ensureRunning: downstream.ensureRunning,
      readActiveBusinessFact: downstream.readBusinessFact,
    })),
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

/** 合法 global config fixture（真实 snapshotLLMConfig/resolveLLMConfig 参与身份派生）。 */
function makeGlobal(model: string) {
  return {
    llm: {
      primary: {
        preset: 'anthropic',
        api_key: '${ANTHROPIC_API_KEY}',
        model,
        temperature: 0.7,
        timeout_ms: 30000,
      },
      retry_attempts: 2,
      retry_delay_ms: 1000,
    },
  };
}

/** 门控 deps：loadGlobal 每次调用经 globalOf 取当前配置（可脚本化漂移）。 */
function makeGateDeps(globalOf: () => ReturnType<typeof makeGlobal>) {
  return {
    fsFactory,
    rootConfig: {
      loadGlobal: vi.fn(() => globalOf()),
      saveGlobalExclusive: vi.fn(),
      patchPrimary: vi.fn(async () => {}),
      completeInitialization: vi.fn(),
    },
  };
}

/** Phase 1927 Step C：默认 ready 业务事实（与 claude-x fixture 身份一致）。 */
const MOTION_FACT_GENERATION = 'gen-motion-1';
function mockBusinessFactOk(identity: string) {
  downstream.readBusinessFact.mockImplementation(() => ({
    kind: 'ok',
    generationId: MOTION_FACT_GENERATION,
    raw: encodeMotionLLMReadyFact({
      generationId: MOTION_FACT_GENERATION,
      llmIdentity: identity,
      committedAt: '2026-09-29T00:00:00.000Z',
    }),
  }));
}

const PROBE_FAIL = { ok: false as const, errorType: 'auth' as const, message: 'invalid key', provider: 'anthropic' };

/** probe mock：成功并回带被测快照 identity（真实实现的回声行为）。 */
function mockProbeOk() {
  conn.probeLLMConnection.mockImplementation(async (snapshot: { config: { primary: { model: string } }; identity: string }) =>
    ({ ok: true, model: snapshot.config.primary.model, identity: snapshot.identity }));
}

/** probe mock：失败并回带 identity。 */
function mockProbeFail(failure: typeof PROBE_FAIL = PROBE_FAIL) {
  conn.probeLLMConnection.mockImplementation(async (snapshot: { identity: string }) =>
    ({ ...failure, identity: snapshot.identity }));
}

function auditTypes(): string[] {
  return auditRec.entries.map(e => e[0]);
}

let tmpDir: string;
let savedRoot: string | undefined;

beforeEach(() => {
  h.rlAnswers.queue = [];
  h.rlCreateCalls = 0;
  auditRec.entries = [];
  conn.probeLLMConnection.mockReset();
  conn.promptReconfigure.mockReset();
  downstream.init.mockClear();
  downstream.motionInit.mockClear();
  downstream.chat.mockClear();
  downstream.ensureRunning.mockClear();
  downstream.ensureRunning.mockImplementation(async () => ({ kind: 'spawned', pid: 4242 }));
  downstream.readBusinessFact.mockReset();
  mockBusinessFactOk(snapshotLLMConfig(makeGlobal('claude-x')).identity);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1926-gate-'));
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
  delete process.env.MISTRAL_API_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('start LLM gate (unit)', () => {
  it('A. probe 成功：audit attempted→succeeded，返回带身份的验证事实', async () => {
    mockProbeOk();
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const verified = await ensureStartLLMVerified(makeGateDeps(() => makeGlobal('claude-x')), {
      audit: mockAudit, interactive: true,
    });

    expect(conn.probeLLMConnection).toHaveBeenCalledTimes(1);
    expect(auditTypes()).toEqual(['cli_start_probe_attempted', 'cli_start_probe_succeeded']);
    expect(verified.via).toBe('start');
    expect(verified.probe.model).toBe('claude-x');
    expect(verified.snapshot.identity).toBe(snapshotLLMConfig(makeGlobal('claude-x')).identity);
    expect(h.rlCreateCalls).toBe(0);
  });

  it('A2. preVerified 身份相等：零 probe 复用 init 验证事实', async () => {
    const initVerified = {
      snapshot: snapshotLLMConfig(makeGlobal('claude-x')),
      probe: { model: 'claude-x' },
      via: 'init' as const,
    };
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const verified = await ensureStartLLMVerified(makeGateDeps(() => makeGlobal('claude-x')), {
      audit: mockAudit, interactive: true, preVerified: initVerified,
    });

    expect(conn.probeLLMConnection).not.toHaveBeenCalled();
    expect(verified).toBe(initVerified);
    expect(auditTypes()).toEqual([]);
  });

  it('A3. preVerified 身份漂移（stale_init_boolean 修复锁）：全量重验不零 probe 放行', async () => {
    mockProbeOk();
    const staleVerified = {
      snapshot: snapshotLLMConfig(makeGlobal('model-A')),
      probe: { model: 'model-A' },
      via: 'init' as const,
    };
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const verified = await ensureStartLLMVerified(makeGateDeps(() => makeGlobal('model-B')), {
      audit: mockAudit, interactive: true, preVerified: staleVerified,
    });

    // init 验证的是 A、当前是 B → 不得复用；B 经真实 probe 后才放行
    expect(conn.probeLLMConnection).toHaveBeenCalledTimes(1);
    expect(verified.via).toBe('start');
    expect(verified.snapshot.identity).toBe(snapshotLLMConfig(makeGlobal('model-B')).identity);
    expect(auditTypes()).toEqual([
      'cli_start_probe_failed',      // reason=stale_preverified_identity
      'cli_start_probe_attempted',
      'cli_start_probe_succeeded',
    ]);
    expect(auditRec.entries[0][1]).toBe('reason=stale_preverified_identity');
  });

  it('B. 非交互 probe 失败：code=3、不进 readline、audit aborted(non_interactive)', async () => {
    mockProbeFail();
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const err = await ensureStartLLMVerified(makeGateDeps(() => makeGlobal('claude-x')), {
      audit: mockAudit, interactive: false,
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
    conn.probeLLMConnection
      .mockImplementationOnce(async (snapshot: { identity: string }) => ({ ...PROBE_FAIL, identity: snapshot.identity }))
      .mockImplementation(async (snapshot: { config: { primary: { model: string } }; identity: string }) =>
        ({ ok: true, model: snapshot.config.primary.model, identity: snapshot.identity }));
    h.rlAnswers.queue = ['1'];
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const verified = await ensureStartLLMVerified(makeGateDeps(() => makeGlobal('claude-x')), {
      audit: mockAudit, interactive: true,
    });

    expect(conn.probeLLMConnection).toHaveBeenCalledTimes(2);
    expect(verified.via).toBe('start');
    expect(auditTypes()).toEqual([
      'cli_start_probe_attempted',
      'cli_start_probe_failed',
      'cli_start_probe_attempted',
      'cli_start_probe_succeeded',
    ]);
    expect(auditRec.entries[3][1]).toBe('via=retry');
  });

  it('D. 交互 reconfigure：返回快照身份相等 → 放行', async () => {
    mockProbeFail();
    conn.promptReconfigure.mockImplementation(async () => snapshotLLMConfig(makeGlobal('claude-x')));
    h.rlAnswers.queue = ['2'];
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const verified = await ensureStartLLMVerified(makeGateDeps(() => makeGlobal('claude-x')), {
      audit: mockAudit, interactive: true,
    });

    expect(conn.promptReconfigure).toHaveBeenCalledTimes(1);
    expect(conn.promptReconfigure.mock.calls[0][2]).toBe('auth');
    // reconfigure 已对新快照 probe 成功 → 身份复核通过即放行，不重复 probe
    expect(conn.probeLLMConnection).toHaveBeenCalledTimes(1);
    expect(verified.probe.model).toBe('claude-x');
    expect(auditTypes()).toEqual([
      'cli_start_probe_attempted',
      'cli_start_probe_failed',
      'cli_start_probe_succeeded',
    ]);
    expect(auditRec.entries[2][1]).toBe('via=reconfigure');
  });

  it('E. 交互 cancel：code=3、audit aborted(user_cancel)', async () => {
    mockProbeFail();
    h.rlAnswers.queue = ['n'];
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const err = await ensureStartLLMVerified(makeGateDeps(() => makeGlobal('claude-x')), {
      audit: mockAudit, interactive: true,
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

  it('F. probe 期间配置漂移（change_during_probe 修复锁）：丢弃结果，新配置重新 probe', async () => {
    mockProbeOk();
    // loadGlobal 读序列：初读 A → probe 后复核 B（漂移）→ 复核 B（稳定）
    const models = ['model-A', 'model-B'];
    const globalOf = () => makeGlobal(models.length > 1 ? models.shift()! : 'model-B');
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const verified = await ensureStartLLMVerified(makeGateDeps(globalOf), {
      audit: mockAudit, interactive: true,
    });

    // A 的 probe 结果被丢弃（audit 留痕），B 经自己的 probe 才放行
    expect(conn.probeLLMConnection).toHaveBeenCalledTimes(2);
    expect(verified.snapshot.identity).toBe(snapshotLLMConfig(makeGlobal('model-B')).identity);
    expect(auditTypes()).toEqual([
      'cli_start_probe_attempted',
      'cli_start_probe_failed',      // reason=snapshot_drift
      'cli_start_probe_attempted',
      'cli_start_probe_succeeded',
    ]);
    expect(auditRec.entries[1][1]).toBe('reason=snapshot_drift');
  });

  it('G. 持续漂移：有界后 fail-closed（不猜哪个配置进 chat）', async () => {
    mockProbeOk();
    let seq = 0;
    const globalOf = () => makeGlobal(`model-${seq++}`);
    const { ensureStartLLMVerified } = await import('../../src/cli/start-llm-gate.js');

    const err = await ensureStartLLMVerified(makeGateDeps(globalOf), {
      audit: mockAudit, interactive: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_GATE_EXIT_CODE);
    expect((err as CliError).message).toMatch(/concurrently/);
    // 漂移重验有界（MAX_SNAPSHOT_DRIFT_ATTEMPTS=3），不无限循环
    expect(conn.probeLLMConnection).toHaveBeenCalledTimes(3);
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

  it('I. 非交互首次配置：draft probe 成功后提交；key 只写 ${VAR} 引用；缺参 → code=2 零 probe 零落盘', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
    mockProbeOk();
    const { runNonInteractiveFirstRun } = await import('../../src/cli/first-run-setup.js');

    // 完整参数：probe 后才落盘且 api_key 是引用而非明文
    const deps = makeGateDeps(() => makeGlobal('claude-x'));
    const outcome = await runNonInteractiveFirstRun(deps, {
      provider: 'anthropic', model: 'claude-x', apiKeyEnv: 'ANTHROPIC_API_KEY', nonInteractive: true,
    }, mockAudit);
    expect(outcome.kind).toBe('verified');
    expect(conn.probeLLMConnection).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.saveGlobalExclusive).toHaveBeenCalledTimes(1);
    const saved = deps.rootConfig.saveGlobalExclusive.mock.calls[0][0] as {
      llm: { primary: { api_key: string; model: string; preset: string } };
    };
    expect(saved.llm.primary.api_key).toBe('${ANTHROPIC_API_KEY}');
    expect(JSON.stringify(saved)).not.toContain('sk-test-secret');
    expect(deps.rootConfig.completeInitialization).toHaveBeenCalledTimes(1);

    // 缺 key（无 --api-key-env 且无 CHESTNUT_LLM_API_KEY）→ code=2 零 probe 零落盘
    conn.probeLLMConnection.mockReset();
    const deps2 = makeGateDeps(() => makeGlobal('claude-x'));
    const err = await runNonInteractiveFirstRun(deps2, {
      provider: 'anthropic', model: 'claude-x', nonInteractive: true,
    }, mockAudit).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_USAGE_EXIT_CODE);
    expect(conn.probeLLMConnection).not.toHaveBeenCalled();
    expect(deps2.rootConfig.saveGlobalExclusive).not.toHaveBeenCalled();
    expect(h.rlCreateCalls).toBe(0);
  });

  it('I2. 非交互首次 probe 失败：code=3 且不落盘', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
    mockProbeFail();
    const { runNonInteractiveFirstRun } = await import('../../src/cli/first-run-setup.js');
    const deps = makeGateDeps(() => makeGlobal('claude-x'));

    const err = await runNonInteractiveFirstRun(deps, {
      provider: 'anthropic', model: 'claude-x', apiKeyEnv: 'ANTHROPIC_API_KEY', nonInteractive: true,
    }, mockAudit).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(START_GATE_EXIT_CODE);
    expect(deps.rootConfig.saveGlobalExclusive).not.toHaveBeenCalled();
    expect(deps.rootConfig.completeInitialization).not.toHaveBeenCalled();
    expect(h.rlCreateCalls).toBe(0);
  });

  it('R. 非交互 catalog provider（无 preset）：写 provider_id 不落 preset；缺 --model / 缺 key → code=2', async () => {
    process.env.MISTRAL_API_KEY = 'sk-mistral-test';
    mockProbeOk();
    const { runNonInteractiveFirstRun } = await import('../../src/cli/first-run-setup.js');

    // 完整参数：provider_id 落盘、preset 缺席、key 只写引用
    const deps = makeGateDeps(() => makeGlobal('claude-x'));
    const outcome = await runNonInteractiveFirstRun(deps, {
      provider: 'mistral', model: 'codestral-latest', apiKeyEnv: 'MISTRAL_API_KEY', nonInteractive: true,
    }, mockAudit);
    expect(outcome.kind).toBe('verified');
    expect(deps.rootConfig.saveGlobalExclusive).toHaveBeenCalledTimes(1);
    const saved = deps.rootConfig.saveGlobalExclusive.mock.calls[0][0] as {
      llm: { primary: Record<string, unknown> };
    };
    expect(saved.llm.primary['provider_id']).toBe('mistral');
    expect(saved.llm.primary['preset']).toBeUndefined();
    expect(saved.llm.primary['model']).toBe('codestral-latest');
    expect(saved.llm.primary['api_key']).toBe('${MISTRAL_API_KEY}');
    expect(JSON.stringify(saved)).not.toContain('sk-mistral-test');

    // 缺 --model → code=2 零落盘（catalog provider 无默认 model）
    const deps2 = makeGateDeps(() => makeGlobal('claude-x'));
    const errNoModel = await runNonInteractiveFirstRun(deps2, {
      provider: 'mistral', apiKeyEnv: 'MISTRAL_API_KEY', nonInteractive: true,
    }, mockAudit).catch((e: unknown) => e);
    expect(errNoModel).toBeInstanceOf(CliError);
    expect((errNoModel as CliError).code).toBe(START_USAGE_EXIT_CODE);
    expect((errNoModel as CliError).message).toMatch(/--model/);
    expect(deps2.rootConfig.saveGlobalExclusive).not.toHaveBeenCalled();

    // 缺 key（api_key 派生 profile）→ code=2 零落盘
    const deps3 = makeGateDeps(() => makeGlobal('claude-x'));
    const errNoKey = await runNonInteractiveFirstRun(deps3, {
      provider: 'mistral', model: 'codestral-latest', nonInteractive: true,
    }, mockAudit).catch((e: unknown) => e);
    expect(errNoKey).toBeInstanceOf(CliError);
    expect((errNoKey as CliError).code).toBe(START_USAGE_EXIT_CODE);
    expect(deps3.rootConfig.saveGlobalExclusive).not.toHaveBeenCalled();
  });

  it('S. initialized patch：catalog 换边清 preset，preset 换边清 provider_id', async () => {
    process.env.MISTRAL_API_KEY = 'sk-mistral-test';
    const { applyStartLLMOptions } = await import('../../src/cli/start-llm-gate.js');

    const deps = makeGateDeps(() => makeGlobal('claude-x'));
    await applyStartLLMOptions(deps, {
      provider: 'mistral', model: 'codestral-latest', apiKeyEnv: 'MISTRAL_API_KEY', nonInteractive: true,
    });
    expect(deps.rootConfig.patchPrimary).toHaveBeenCalledTimes(1);
    const patch = deps.rootConfig.patchPrimary.mock.calls[0][0] as Record<string, unknown>;
    expect(patch['provider_id']).toBe('mistral');
    expect('preset' in patch && patch['preset'] === undefined).toBe(true); // 换边清除

    const deps2 = makeGateDeps(() => makeGlobal('claude-x'));
    await applyStartLLMOptions(deps2, {
      provider: 'anthropic', model: 'claude-x', apiKeyEnv: 'MISTRAL_API_KEY', nonInteractive: true,
    });
    const patch2 = deps2.rootConfig.patchPrimary.mock.calls[0][0] as Record<string, unknown>;
    expect(patch2['preset']).toBe('anthropic');
    expect('provider_id' in patch2 && patch2['provider_id'] === undefined).toBe(true);
  });
});

describe('start command gate wiring', () => {
  /** initialized workspace 的 start deps（门控前状态就绪，只欠 LLM 验证）。 */
  function startDeps() {
    return {
      fsFactory,
      rootConfig: {
        isInitialized: () => true,
        loadGlobal: vi.fn(() => makeGlobal('claude-x')),
        saveGlobal: vi.fn(),
        saveGlobalExclusive: vi.fn(),
        patchPrimary: vi.fn(async () => {}),
        getInitializationState: () => 'ready' as const,
        completeInitialization: vi.fn(),
      },
    };
  }

  it('J. 非交互 probe 失败：零 supervision/daemon/onboarding/chat、退出码 3', async () => {
    mockProbeFail();
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
    expect(conn.probeLLMConnection).not.toHaveBeenCalled();
    expect(deps.rootConfig.saveGlobalExclusive).not.toHaveBeenCalled();
    expect(ensureSupervision).not.toHaveBeenCalled();
    expect(downstream.init).not.toHaveBeenCalled();
    expect(h.rlCreateCalls).toBe(0);
  });

  it('K2. 非 TTY 首次（无 --non-interactive）：走非交互分支，缺参 code=2、零 readline', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const { startCommand } = await import('../../src/cli/commands/start.js');
      const ensureSupervision = vi.fn(async () => {});
      const deps = startDeps();
      deps.rootConfig.isInitialized = () => false;
      deps.rootConfig.getInitializationState = () => 'absent' as const;

      const err = await startCommand(deps, { audit: mockAudit, ensureSupervision }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(START_USAGE_EXIT_CODE);
      expect(conn.probeLLMConnection).not.toHaveBeenCalled();
      expect(deps.rootConfig.saveGlobalExclusive).not.toHaveBeenCalled();
      expect(ensureSupervision).not.toHaveBeenCalled();
      expect(h.rlCreateCalls).toBe(0);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  // ── Phase 1927 Step C：ready 后 LLM 身份业务事实消费（三 outcome 统一 fail-closed）──

  /** onboarding complete 落盘（archive 全完成），start 直接进 chat 分支。 */
  function seedOnboardingComplete() {
    const dir = path.join(tmpDir, 'motion', 'contract', 'archive', ONBOARDING_CONTRACT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'contract.yaml'), 'title: "Onboarding"\n');
    fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({
      schema_version: 1,
      subtasks: {
        language: { status: 'completed' },
        identity: { status: 'completed' },
      },
    }));
  }

  it('L. spawned + 事实身份匹配 → 消费事实后进 chat', async () => {
    mockProbeOk();
    seedOnboardingComplete();
    const { startCommand } = await import('../../src/cli/commands/start.js');

    await startCommand(startDeps(), { audit: mockAudit, ensureSupervision: vi.fn(async () => {}) }, {
      nonInteractive: true,
    });

    expect(downstream.ensureRunning).toHaveBeenCalledTimes(1);
    expect(downstream.readBusinessFact).toHaveBeenCalledTimes(1);
    expect(downstream.chat).toHaveBeenCalledTimes(1);
  });

  it('M. 事实缺失（watchdog winner / 旧 daemon 未发布）→ fail-closed 不进 chat', async () => {
    mockProbeOk();
    seedOnboardingComplete();
    downstream.readBusinessFact.mockImplementation(() => ({
      kind: 'fact_missing',
      generationId: MOTION_FACT_GENERATION,
    }));
    const { startCommand } = await import('../../src/cli/commands/start.js');

    const err = await startCommand(startDeps(), { audit: mockAudit, ensureSupervision: vi.fn(async () => {}) }, {
      nonInteractive: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).cause).toBeInstanceOf(MotionLLMIdentityMismatchError);
    expect(((err as CliError).cause as MotionLLMIdentityMismatchError).failure).toBe('fact_missing');
    expect(downstream.chat).not.toHaveBeenCalled();
  });

  it('N. 事实身份不等（配置 A 的 daemon + 验证 B 的 start）→ fail-closed 不进 chat', async () => {
    mockProbeOk();
    seedOnboardingComplete();
    // daemon 事实身份 = 另一配置（model-y）的身份
    mockBusinessFactOk(snapshotLLMConfig(makeGlobal('model-y')).identity);
    const { startCommand } = await import('../../src/cli/commands/start.js');

    const err = await startCommand(startDeps(), { audit: mockAudit, ensureSupervision: vi.fn(async () => {}) }, {
      nonInteractive: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    const cause = (err as CliError).cause as MotionLLMIdentityMismatchError;
    expect(cause).toBeInstanceOf(MotionLLMIdentityMismatchError);
    expect(cause.failure).toBe('identity_mismatch');
    expect(cause.message).not.toContain('ANTHROPIC_API_KEY');
    expect(downstream.chat).not.toHaveBeenCalled();
  });

  it('O. 事实损坏（malformed）→ fail-closed 不进 chat', async () => {
    mockProbeOk();
    seedOnboardingComplete();
    downstream.readBusinessFact.mockImplementation(() => ({
      kind: 'ok',
      generationId: MOTION_FACT_GENERATION,
      raw: 'not-json',
    }));
    const { startCommand } = await import('../../src/cli/commands/start.js');

    const err = await startCommand(startDeps(), { audit: mockAudit, ensureSupervision: vi.fn(async () => {}) }, {
      nonInteractive: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect(((err as CliError).cause as MotionLLMIdentityMismatchError).failure).toBe('fact_malformed');
    expect(downstream.chat).not.toHaveBeenCalled();
  });

  it('P. already_ready outcome 同样消费事实（不加门即回归 F1）', async () => {
    mockProbeOk();
    seedOnboardingComplete();
    downstream.ensureRunning.mockImplementation(async () => ({ kind: 'already_ready', pid: 4242 }));
    const { startCommand } = await import('../../src/cli/commands/start.js');

    await startCommand(startDeps(), { audit: mockAudit, ensureSupervision: vi.fn(async () => {}) }, {
      nonInteractive: true,
    });

    expect(downstream.readBusinessFact).toHaveBeenCalledTimes(1);
    expect(downstream.chat).toHaveBeenCalledTimes(1);
  });

  it('Q. joined outcome + 事实身份不等 → fail-closed 不进 chat', async () => {
    mockProbeOk();
    seedOnboardingComplete();
    downstream.ensureRunning.mockImplementation(async () => ({ kind: 'joined', pid: 4242, generationId: MOTION_FACT_GENERATION }));
    mockBusinessFactOk(snapshotLLMConfig(makeGlobal('model-y')).identity);
    const { startCommand } = await import('../../src/cli/commands/start.js');

    const err = await startCommand(startDeps(), { audit: mockAudit, ensureSupervision: vi.fn(async () => {}) }, {
      nonInteractive: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect(((err as CliError).cause as MotionLLMIdentityMismatchError).failure).toBe('identity_mismatch');
    expect(downstream.chat).not.toHaveBeenCalled();
  });

  // ── Phase 1945 Step C：热重载后事实同步的消费侧结局 ──

  it('R. 热重载后放行：磁盘配置已切 model-y 且 daemon 已发布新身份 → 进 chat', async () => {
    mockProbeOk();
    seedOnboardingComplete();
    // daemon 热重载成功 → active 事实已被更新为「已应用」身份（model-y）
    mockBusinessFactOk(snapshotLLMConfig(makeGlobal('model-y')).identity);
    const deps = startDeps();
    deps.rootConfig.loadGlobal = vi.fn(() => makeGlobal('model-y'));
    const { startCommand } = await import('../../src/cli/commands/start.js');

    await startCommand(deps, { audit: mockAudit, ensureSupervision: vi.fn(async () => {}) }, {
      nonInteractive: true,
    });

    expect(downstream.readBusinessFact).toHaveBeenCalledTimes(1);
    expect(downstream.chat).toHaveBeenCalledTimes(1);
  });

  it('S. 磁盘配置已变但 daemon 未应用（事实保持旧身份）→ identity_mismatch 不进 chat', async () => {
    mockProbeOk();
    seedOnboardingComplete();
    // 事实仍是出生身份（claude-x）；本次 start 验证的是新配置（model-y）
    mockBusinessFactOk(snapshotLLMConfig(makeGlobal('claude-x')).identity);
    const deps = startDeps();
    deps.rootConfig.loadGlobal = vi.fn(() => makeGlobal('model-y'));
    const { startCommand } = await import('../../src/cli/commands/start.js');

    const err = await startCommand(deps, { audit: mockAudit, ensureSupervision: vi.fn(async () => {}) }, {
      nonInteractive: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect(((err as CliError).cause as MotionLLMIdentityMismatchError).failure).toBe('identity_mismatch');
    expect(downstream.chat).not.toHaveBeenCalled();
  });
});
