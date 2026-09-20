/**
 * Phase 1282 Step B: 首次启动 Watchdog-winner 真实 generation race 回归。
 *
 * 场景（Phase1280 现场）：Watchdog 在 CLI 之前提交 Motion spawning generation，
 * CLI `start` 的 ensureRunning 命中合法 conflict 后必须 join exact winner 至 ready，
 * 不得报 `chestnut start failed`、不得二次 spawn、不得阻断 Onboarding contract。
 *
 * 真实性边界：
 * - CLI 侧使用真实 ProcessManager（createProcessManagerForCLI call-through）+
 *   真实临时 workspace 磁盘 generation 协议；
 * - 「Watchdog winner」由第二个独立 PM context 按真实 generation 协议函数推进
 *   （candidate → spawning → pid → ready → active），child PID 是真实存活 sleeper 进程；
 * - 仅隔离语言输入（readline）、Motion init/chat、ContractSystem、notify 四类
 *   与 race 无关的交互。
 *
 * Gating：CLI PM 的 system audit 同步落盘 <workspace>/.chestnut/audit.tsv；
 * 等到 `process_generation_commit_lost` 出现即证明 CLI 已 conflict 并进入 join 轮询，
 * 此时 winner 才写 ready + activate —— 保证走的是 join 而非 already_ready。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import {
  newProcessGeneration,
  prepareGeneration,
  commitSpawning,
  writeChildPid,
  writeReadyFact,
  activateGeneration,
} from '../../src/foundation/process-manager/generation.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../src/foundation/process-manager/audit-events.js';
import { makeAudit } from '../helpers/audit.js';
import type { ProcessManagerContext } from '../../src/foundation/process-manager/types.js';
import { createRootConfigLegacyMigration } from '../../src/assembly/index.js';

const h = vi.hoisted(() => ({
  counts: { contractCreate: 0, notify: 0, chat: 0, motionInit: 0 },
  ensureOutcome: undefined as Promise<unknown> | undefined,
}));

vi.mock('../../src/cli/commands/init.js', () => ({
  initCommand: vi.fn(async () => {}),
}));

vi.mock('../../src/cli/commands/motion.js', () => ({
  initCommand: vi.fn(async () => { h.counts.motionInit++; }),
  chatCommand: vi.fn(async () => { h.counts.chat++; }),
  stopCommand: vi.fn(async () => {}),
  motionOutboxCommand: vi.fn(async () => {}),
}));

vi.mock('../../src/foundation/process-manager/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/process-manager/index.js')>();
  return {
    ...actual,
    // call-through 真实 PM；仅捕获 ensureRunning outcome 供断言（不改变任何行为）
    createProcessManagerForCLI: vi.fn((deps: Parameters<typeof actual.createProcessManagerForCLI>[0]) => {
      const pm = actual.createProcessManagerForCLI(deps);
      const originalEnsureRunning = pm.ensureRunning.bind(pm);
      pm.ensureRunning = ((...args: Parameters<typeof pm.ensureRunning>) => {
        h.ensureOutcome = originalEnsureRunning(...args);
        return h.ensureOutcome;
      }) as typeof pm.ensureRunning;
      return pm;
    }),
  };
});

vi.mock('../../src/core/contract/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/contract/index.js')>();
  return {
    ...actual,
    // phase 1879 Step B: start 的 ContractSystem 装配归 Assembly 窄 action context
    // （createMotionContractActionContext 内经 createContractSystem 工厂构造）——
    // mock 目标随装配收口从 ContractSystem 类迁到 createContractSystem 工厂。
    createContractSystem: vi.fn(async () => ({
      create: async (): Promise<string> => {
        h.counts.contractCreate++;
        return 'onboarding-race';
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
      notify: vi.fn(() => { h.counts.notify++; }),
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
    isInitialized: () => fs.existsSync(path.join(tmpDir, '.chestnut', 'config.yaml')),
    loadGlobal: vi.fn(),
    saveGlobal: vi.fn(),
    patchPrimary: vi.fn(),
  },
  rootConfigLegacy: createRootConfigLegacyMigration({ fsFactory }),
});

let tmpDir: string;
let savedRoot: string | undefined;
let sleeperPid: number | undefined;

function waitForFileContent(filePath: string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 10; // 远小于 join 轮询间隔，保证及时释放 winner ready
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8').includes(needle)) {
          resolve();
          return;
        }
      } catch { /* 读取竞态：下一轮重试 */ }
      if (Date.now() > deadline) {
        reject(new Error(`timeout waiting for ${needle} in ${filePath}`));
        return;
      }
      setTimeout(check, POLL_MS);
    };
    check();
  });
}

beforeEach(() => {
  h.counts = { contractCreate: 0, notify: 0, chat: 0, motionInit: 0 };
  h.ensureOutcome = undefined;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1282-race-'));
  savedRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = tmpDir;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (sleeperPid !== undefined) {
    try { process.kill(sleeperPid, 'SIGKILL'); } catch { /* already dead */ }
    sleeperPid = undefined;
  }
  if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = savedRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('start watchdog winner spawn race (phase 1282)', () => {
  it('Watchdog spawning winner ready 后 CLI join 成功：零二次 spawn、contract/notify/chat 各一次', async () => {
    const { startCommand } = await import('../../src/cli/commands/start.js');
    const { resolveClawDaemonDir, MOTION_CLAW_ID } = await import('../../src/core/claw-topology/index.js');

    const motionDaemonDir = resolveClawDaemonDir(MOTION_CLAW_ID);

    // --- Watchdog 侧：真实存活 child + 真实 generation 协议提交 spawning winner ---
    const { audit: winnerAudit } = makeAudit();
    const winnerCtx: ProcessManagerContext = {
      fs: new NodeFileSystem({ baseDir: tmpDir }),
      audit: winnerAudit,
    };
    const record = newProcessGeneration(winnerCtx, motionDaemonDir);
    prepareGeneration(winnerCtx, record);
    expect(commitSpawning(winnerCtx, record).kind).toBe('committed');

    const SLEEPER_INTERVAL_MS = 1000; // sleeper 保活心跳：仅防进程退出，数值不参与断言
    const sleeper = spawn(process.execPath, ['-e', `setInterval(()=>{},${SLEEPER_INTERVAL_MS})`], {
      detached: true,
      stdio: 'ignore',
    });
    sleeper.unref();
    expect(sleeper.pid).toBeDefined();
    sleeperPid = sleeper.pid!;
    expect((await writeChildPid(winnerCtx, record, sleeperPid)).kind).toBe('written');

    // --- CLI 侧：真实 PM；winner 尚未 ready，ensureRunning 必走 conflict → join ---
    const ensureSupervision = vi.fn(async () => {});
    const startPromise = startCommand(startDeps(), { ensureSupervision });

    // CLI PM system audit 同步落盘；commit_lost 出现 = CLI 已 conflict 并进入 join 轮询
    const auditFile = path.join(tmpDir, '.chestnut', 'audit.tsv');
    await waitForFileContent(auditFile, PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST, 10000);

    // winner child：写 ready 事实并 activate（spawning → active）
    expect((await writeReadyFact(winnerCtx, record, sleeperPid)).kind).toBe('written');
    const activation = activateGeneration(winnerCtx, motionDaemonDir, {
      generationId: record.generation_id,
      pid: sleeperPid,
    });
    expect(activation.kind).toBe('activated');

    // --- start 全程不抛：Onboarding contract 正常创建 ---
    await expect(startPromise).resolves.toBeUndefined();

    // ensureRunning outcome：joined exact winner generation（非 already_ready / spawned）
    expect(h.ensureOutcome).toBeDefined();
    await expect(h.ensureOutcome).resolves.toEqual({
      kind: 'joined',
      pid: sleeperPid,
      generationId: record.generation_id,
    });

    // 交互各恰好一次
    expect(h.counts.contractCreate).toBe(1);
    expect(h.counts.notify).toBe(1);
    expect(h.counts.chat).toBe(1);

    // CLI 真实 audit：join 成功落盘、零自有 spawn（未二次 spawn child）
    const auditContent = fs.readFileSync(auditFile, 'utf-8');
    expect(auditContent).toContain(PROCESS_MANAGER_AUDIT_EVENTS.ENSURE_JOINED);
    expect(auditContent).toContain(`generation=${record.generation_id}`);
    expect(auditContent).not.toContain(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED);
  });
});
