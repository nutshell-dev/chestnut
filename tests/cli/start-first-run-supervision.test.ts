/**
 * Phase 1280 Step B: 首次启动延后监督行为回归。
 *
 * 真实临时 workspace（CHESTNUT_ROOT 指向 mkdtemp 目录）+ 真实 fs/config 落盘，
 * 隔离语言输入、daemon spawn、Motion init/chat 与 LLM 交互（initCommand mock
 * 写真实 .chestnut/config.yaml，以保留「bootstrap 落盘 → ensure」的磁盘时序）。
 *
 * 覆盖：
 * 1. 全新 workspace：init 完成（config 落盘）后 ensure 一次，再进入 Motion 动作；
 * 2. 已初始化 workspace：不执行 init，ensure 一次后进入 Motion 动作；
 * 3. init 失败：ensure 零次、后续动作零次，错误显式暴露；
 * 4. ensure 失败：init 产物保留，Motion 后续动作零次，错误显式暴露。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeFileSystem } from '../../src/foundation/fs/index.js';

const h = vi.hoisted(() => ({
  order: [] as string[],
  failSetup: false,
  configExistsAtEnsure: undefined as boolean | undefined,
  workspaceRoot: '',
}));

vi.mock('../../src/cli/first-run-setup.js', () => ({
  runFirstRunSetup: vi.fn(async () => {
    h.order.push('setup');
    if (h.failSetup) throw new Error('setup boom');
    // 模拟 probe-before-commit 的成功提交：写真实 global config，ensure 时必须已存在
    const chestnutDir = path.join(h.workspaceRoot, '.chestnut');
    fs.mkdirSync(chestnutDir, { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, 'config.yaml'), 'version: "1"\n');
    return {
      kind: 'verified',
      verified: { snapshot: { config: {}, identity: 'test-gate-identity' }, probe: { model: 'test-model' }, via: 'init' },
    };
  }),
  runNonInteractiveFirstRun: vi.fn(async () => {
    throw new Error('unexpected non-interactive setup in supervision test');
  }),
}));

// Phase 1925 Step E / 1926 Step C：LLM 验证门控独立 own 测试；本文件治监督边界，
// 门控降为顺序见证（setup 后、ensure 前各一次），返回假身份供 spawn options 消费。
vi.mock('../../src/cli/start-llm-gate.js', () => ({
  validateStartLLMOptions: vi.fn(),
  applyStartLLMOptions: vi.fn(async () => {}),
  START_GATE_EXIT_CODE: 3,
  ensureStartLLMVerified: vi.fn(async () => {
    h.order.push('llm-gate');
    return { snapshot: { config: {}, identity: 'test-gate-identity' }, probe: { model: 'test-model' }, via: 'start' };
  }),
}));

vi.mock('../../src/cli/commands/motion.js', () => ({
  initCommand: vi.fn(async () => { h.order.push('motion-init'); }),
  chatCommand: vi.fn(async () => { h.order.push('chat'); }),
  stopCommand: vi.fn(async () => {}),
  motionOutboxCommand: vi.fn(async () => {}),
}));

vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>();
  // Phase 1927 Step C：ready 业务事实缝——与上方门控 mock 的假身份一致（真实协议见
  // start-watchdog-spawn-race / start-llm-gate 测试）
  const { encodeMotionLLMReadyFact } = await import('../../src/daemon/llm-ready-fact.js');
  return {
    ...actual,
    // phase 1282 Step B: start 只消费 ensureRunning（ready-winner convergence），
    // 不再组合 isAlive+spawn。
    createProcessManagerForCLI: vi.fn(() => ({
      ensureRunning: vi.fn(async () => {
        h.order.push('daemon-spawn');
        return { kind: 'spawned', pid: 4242 };
      }),
      readActiveBusinessFact: vi.fn(() => ({
        kind: 'ok',
        generationId: 'gen-test',
        raw: encodeMotionLLMReadyFact({
          generationId: 'gen-test',
          llmIdentity: 'test-gate-identity',
          committedAt: '2026-09-29T00:00:00.000Z',
        }),
      })),
    })),
  };
});

vi.mock('../../src/core/contract/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/contract/index.js')>();
  return {
    ...actual,
    // phase 1879 Step B: start 的 ContractSystem 装配归 Assembly 窄 action context
    // （createMotionContractActionContext 内经 createContractSystem 工厂构造）——
    // mock 目标随装配收口从 ContractSystem 类迁到 createContractSystem 工厂。
    // phase 1901 Step B: motion context 注册 summon-verify policy，mock 补 registerCreatePolicy。
    createContractSystem: vi.fn(async () => ({
      registerCreatePolicy: vi.fn(),
      create: async (): Promise<string> => {
        h.order.push('contract-create');
        return 'onboarding-test';
      },
    })),
  };
});

// phase 1864 Step C（CT-D2）：notify 发送归 Messaging（createClawNotifier）；mock 目标随 owner 迁移。
vi.mock('../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/messaging/index.js')>();
  return {
    ...actual,
    createClawNotifier: vi.fn(() => ({
      notify: vi.fn(() => { h.order.push('notify'); }),
      notifyAsync: vi.fn(async () => {}),
      notifyIntentAsync: vi.fn(async () => {}),
    })),
  };
});

vi.mock('readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb('auto'),
    close: () => {},
  }),
}));

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
const startDeps = () => ({
  fsFactory,
  rootConfig: {
    isInitialized: () => fs.existsSync(path.join(h.workspaceRoot, '.chestnut', 'config.yaml')),
    loadGlobal: vi.fn(),
    saveGlobal: vi.fn(),
    patchPrimary: vi.fn(),
    // Phase 1911 Step D：typed 初始化状态面（本测试治监督边界，非 init 协议，
    // mock 保持「config 在 = ready」的旧语义）
    getInitializationState: () =>
      fs.existsSync(path.join(h.workspaceRoot, '.chestnut', 'config.yaml')) ? 'ready' as const : 'absent' as const,
    completeInitialization: vi.fn(),
  },
});

let tmpDir: string;
let savedRoot: string | undefined;

function makeEnsureSupervision(fail = false) {
  return vi.fn(async () => {
    h.order.push('ensure');
    h.configExistsAtEnsure = fs.existsSync(
      path.join(h.workspaceRoot, '.chestnut', 'config.yaml'),
    );
    if (fail) throw new Error('watchdog spawn failed');
  });
}

beforeEach(() => {
  h.order = [];
  h.failSetup = false;
  h.configExistsAtEnsure = undefined;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1280-start-'));
  h.workspaceRoot = tmpDir;
  savedRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = tmpDir;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = savedRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('start first-run deferred supervision (phase 1280)', () => {
  it('全新 workspace：setup 提交后 ensure 一次，再进入 Motion 动作', async () => {
    const { startCommand } = await import('../../src/cli/commands/start.js');
    const ensureSupervision = makeEnsureSupervision();

    await startCommand(startDeps(), { ensureSupervision });

    expect(ensureSupervision).toHaveBeenCalledTimes(1);
    // 严格顺序：setup 提交 < ensure < Motion 后续动作（无 pre-init spawn）
    expect(h.order).toEqual([
      'setup',
      'llm-gate',
      'ensure',
      'motion-init',
      'daemon-spawn',
      'contract-create',
      'notify',
      'chat',
    ]);
    // ensure 时 bootstrap config 已完整落盘
    expect(h.configExistsAtEnsure).toBe(true);
  });

  it('已初始化 workspace：不执行 init，ensure 一次后进入 Motion 动作', async () => {
    fs.mkdirSync(path.join(tmpDir, '.chestnut'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.chestnut', 'config.yaml'), 'version: "1"\n');
    const { startCommand } = await import('../../src/cli/commands/start.js');
    const ensureSupervision = makeEnsureSupervision();

    await startCommand(startDeps(), { ensureSupervision });

    expect(ensureSupervision).toHaveBeenCalledTimes(1);
    // 严格顺序：ensure < Motion 后续动作；零 init
    expect(h.order).toEqual([
      'llm-gate',
      'ensure',
      'motion-init',
      'daemon-spawn',
      'contract-create',
      'notify',
      'chat',
    ]);
    expect(h.configExistsAtEnsure).toBe(true);
  });

  it('setup 失败：ensure 零次、Motion 后续动作零次，错误显式暴露', async () => {
    h.failSetup = true;
    const { startCommand } = await import('../../src/cli/commands/start.js');
    const ensureSupervision = makeEnsureSupervision();

    await expect(startCommand(startDeps(), { ensureSupervision }))
      .rejects.toThrow(/chestnut start failed/);

    expect(ensureSupervision).not.toHaveBeenCalled();
    expect(h.order).toEqual(['setup']);
  });

  it('ensure 失败：setup 产物保留，Motion 后续动作零次，错误显式暴露', async () => {
    const { startCommand } = await import('../../src/cli/commands/start.js');
    const ensureSupervision = makeEnsureSupervision(true);

    await expect(startCommand(startDeps(), { ensureSupervision }))
      .rejects.toThrow(/chestnut start failed.*watchdog spawn failed/);

    expect(h.order).toEqual(['setup', 'llm-gate', 'ensure']);
    // setup 产物保留
    expect(fs.existsSync(path.join(tmpDir, '.chestnut', 'config.yaml'))).toBe(true);
  });
});
