/**
 * Phase 1974 Step D: executor-supervisor 集成测试。
 *
 * 真实 temp workspace + 真实 ClawTopology + 真实 NodeFileSystem + 真实
 * listActiveContracts；进程能力（liveness/ensure/restart/heartbeat）注入 fake。
 * 不读 ambient CHESTNUT_ROOT、不跑真实 cron 等 30s（直调 job handler）。
 *
 * 覆盖（coding plan/phase1974 Step D §4 集成矩阵）：
 * 1. clean-stop + active contract：marker 不阻止 ensure（active contract 优先决策）；
 * 2. stop → start motion：首个 tick 拉起有契约 claw、无契约 claw 保持停止；
 * 3. 空 workspace：handler 不 throw、不 spawn、不写错误 audit；
 * 4. watchdog 退役静态回归：无 executor recovery 残留、motion restart 保留。
 *
 * 注：daemon 启动后消费 clean-stop / contract_created 的语义未变（本 phase 不改
 * daemon），由既有 tests/core/event-loop/event-loop.test.ts 覆盖；真实进程集成
 * 按计划风险表隔离，不在本文件复制。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';
import { createExecutorSupervisorJob } from '../../../src/core/contract/jobs/executor-supervisor/index.js';
import { runExecutorSupervisorTick } from '../../../src/core/contract/jobs/executor-supervisor/tick.js';
import type { ExecutorSupervisorDeps } from '../../../src/core/contract/jobs/executor-supervisor/types.js';
import { CONTRACT_ACTIVE_DIR } from '../../../src/core/contract/dirs.js';
import type { EnsureRunningOutcome, LivenessResult } from '../../../src/foundation/process-manager/index.js';
import { absentLiveness } from '../../helpers/liveness-fixtures.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const CONTRACT_ID = '1700000000000-abcd';
const JOB_CONFIG = {
  cron: { jobs: { executor_supervisor: { enabled: true, schedule: 'interval:30s' } } },
};

interface AuditRecord {
  event: string;
  cols: string[];
}

describe('Phase 1974 Step D: executor-supervisor 集成（真实 temp workspace + 真实 topology）', () => {
  let chestnutRoot: string;

  beforeEach(() => {
    chestnutRoot = createTrackedTempDirSync('executor-supervisor-int-');
    fs.mkdirSync(path.join(chestnutRoot, 'motion'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(chestnutRoot, { recursive: true, force: true });
  });

  function clawDir(rawClawId: string): string {
    return path.join(chestnutRoot, 'claws', rawClawId);
  }

  function publishActiveContract(rawClawId: string, contractId = CONTRACT_ID): void {
    const dir = path.join(clawDir(rawClawId), CONTRACT_ACTIVE_DIR, contractId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'contract.yaml'), 'title: integration\n');
  }

  interface HarnessOptions {
    liveness?: (rawClawId: string) => LivenessResult;
  }

  function makeHarness(opts: HarnessOptions = {}) {
    const audits: AuditRecord[] = [];
    const ensureCalls: string[] = [];
    const restartCalls: string[] = [];
    const rootFs = new NodeFileSystem({ baseDir: chestnutRoot });
    const topology = createClawTopology({
      fs: rootFs,
      chestnutRoot,
      motionDir: 'motion',
    });
    const deps: ExecutorSupervisorDeps = {
      clawTopology: topology,
      motionClawId: MOTION_CLAW_ID,
      fsFactory: (baseDir) => new NodeFileSystem({ baseDir }),
      audit: { write: (event: string, ...cols: (string | number)[]) => audits.push({ event, cols: cols.map(String) }) },
      liveness: opts.liveness ?? (() => absentLiveness()),
      ensureDaemon: async (rawClawId): Promise<EnsureRunningOutcome> => {
        ensureCalls.push(rawClawId);
        return { kind: 'spawned', pid: 5150 };
      },
      restartDaemon: async (rawClawId) => {
        restartCalls.push(rawClawId);
        return {
          stop: { kind: 'stopped', pid: 5150, via: 'sigterm' },
          ensured: { kind: 'spawned', pid: 5151 },
        };
      },
      readHeartbeat: () => ({ kind: 'missing' }),
      heartbeatStaleTimeoutMs: 180_000,
    };
    return { deps, audits, ensureCalls, restartCalls };
  }

  it('集成 1：clean-stop marker 不阻止 active contract 的 ensure（active contract 优先）', async () => {
    publishActiveContract('clawA');
    // CLI stop 的 per-claw marker（<clawDir>/clean-stop）——job 不读、不阻止。
    fs.writeFileSync(path.join(clawDir('clawA'), 'clean-stop'), '');
    const { deps, audits, ensureCalls } = makeHarness();

    await runExecutorSupervisorTick(deps);

    expect(ensureCalls).toEqual(['clawA']);
    const ensured = audits.find(a => a.event === 'executor_supervisor_ensured');
    expect(ensured?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', 'trigger=absent', 'outcome=spawned']),
    );
    // marker 原样保留（job 不消费；消费归 daemon 启动后 event-loop）
    expect(fs.existsSync(path.join(clawDir('clawA'), 'clean-stop'))).toBe(true);
  });

  it('集成 2：stop → start motion 首个 tick——有契约 claw 拉起、无契约 claw 保持停止', async () => {
    publishActiveContract('clawA');
    fs.mkdirSync(clawDir('clawB'), { recursive: true }); // 无契约
    const { deps, audits, ensureCalls } = makeHarness();

    // 直调 job handler（不跑真实 cron 等 30s）。
    const job = createExecutorSupervisorJob(deps, JOB_CONFIG);
    expect(job.name).toBe('executor-supervisor');
    await expect(job.handler()).resolves.toBeUndefined();

    expect(ensureCalls).toEqual(['clawA']);
    expect(audits.filter(a => a.cols.includes('claw=clawB'))).toEqual([]);
    // motion 自身不被本 job 监督（归 watchdog）
    expect(audits.filter(a => a.cols.includes('claw=motion'))).toEqual([]);
    expect(ensureCalls).not.toContain('motion');
  });

  it('集成 3：空 workspace（无 claws/ 目录）——handler 不 throw、不 spawn、0 audit', async () => {
    const { deps, audits, ensureCalls, restartCalls } = makeHarness();
    const job = createExecutorSupervisorJob(deps, JOB_CONFIG);

    await expect(job.handler()).resolves.toBeUndefined();

    expect(ensureCalls).toEqual([]);
    expect(restartCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('集成 3b：空 claws/ 目录（已建但无 claw）——同样安全返回、0 audit', async () => {
    fs.mkdirSync(path.join(chestnutRoot, 'claws'), { recursive: true });
    const { deps, audits, ensureCalls } = makeHarness();
    const job = createExecutorSupervisorJob(deps, JOB_CONFIG);

    await expect(job.handler()).resolves.toBeUndefined();
    expect(ensureCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  describe('集成 4：watchdog executor recovery 退役静态回归', () => {
    const watchdogDir = path.join(__dirname, '../../../src/watchdog');

    function readWatchdogSources(): string {
      return fs.readdirSync(watchdogDir)
        .filter(f => f.endsWith('.ts'))
        .map(f => fs.readFileSync(path.join(watchdogDir, f), 'utf8'))
        .join('\n');
    }

    it('executor-recovery.ts 已物理删除、源码无 executor recovery 引用', () => {
      expect(fs.existsSync(path.join(watchdogDir, 'executor-recovery.ts'))).toBe(false);
      const source = readWatchdogSources();
      expect(source).not.toContain('maybeCronExecutorRecovery');
      expect(source).not.toContain('executorRestartStateAPI');
      expect(source).not.toMatch(/EXECUTOR_RECOVERY_SKIPPED|EXECUTOR_HEARTBEAT_STALE|EXECUTOR_UNAVAILABLE_DELIVERED/);
    });

    it('watchdog 只保留 motion daemon 监督（motion restart/ownership 未误删）', () => {
      const watchdogTs = fs.readFileSync(path.join(watchdogDir, 'watchdog.ts'), 'utf8');
      expect(watchdogTs).toContain('decideMotionRestart');
      expect(watchdogTs).toContain('motionRestartStateAPI');
      expect(fs.existsSync(path.join(watchdogDir, 'watchdog-ownership.ts'))).toBe(true);
    });

    it('daemon event-loop 仍 own clean-stop 消费（本 phase 不改 daemon 语义）', () => {
      const eventLoop = fs.readFileSync(
        path.join(__dirname, '../../../src/core/event-loop/event-loop.ts'),
        'utf8',
      );
      expect(eventLoop).toContain("'clean-stop'");
    });
  });
});
