/**
 * Phase 1974 Step B: ContractSystem executor-supervisor job 单测。
 *
 * 注入面完全 fake（clawTopology/liveness/ensureDaemon/restartDaemon/readHeartbeat），
 * contract 扫描走真实 temp workspace + NodeFileSystem（不读 ambient CHESTNUT_ROOT）。
 * 矩阵见 `coding plan/phase1974/Phase 1974 Step D` §4（单元部分）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { runExecutorSupervisorTick } from '../../../src/core/contract/jobs/executor-supervisor/tick.js';
import {
  createExecutorSupervisorJob,
  EXECUTOR_SUPERVISOR_CRON_TIMEOUT_MS,
} from '../../../src/core/contract/jobs/executor-supervisor/index.js';
import { EXECUTOR_SUPERVISOR_AUDIT_EVENTS as EV } from '../../../src/core/contract/jobs/executor-supervisor/audit-events.js';
import type {
  ExecutorSupervisorDeps,
  ExecutorHeartbeatRead,
  RestartDaemonResult,
} from '../../../src/core/contract/jobs/executor-supervisor/types.js';
import { CONTRACT_ACTIVE_DIR } from '../../../src/core/contract/dirs.js';
import { makeClawId, type ClawId } from '../../../src/foundation/claw-identity/index.js';
import type { ClawTopology, Location } from '../../../src/core/claw-topology/index.js';
import type { LivenessResult, EnsureRunningOutcome } from '../../../src/foundation/process-manager/index.js';
import {
  aliveLiveness,
  deadLiveness,
  absentLiveness,
  malformedLiveness,
  probeUnavailableLiveness,
} from '../../helpers/liveness-fixtures.js';

const NOW = 1_800_000_000_000;
const STALE_TIMEOUT_MS = 180_000;
const CONTRACT_ID = '1700000000000-abcd';

interface AuditRecord {
  event: string;
  cols: string[];
}

describe('Phase 1974 Step B: executor-supervisor job', () => {
  let rootDir: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    rootDir = path.join(os.tmpdir(), `executor-supervisor-${randomUUID()}`);
    fs.mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function clawDirOf(rawClawId: string): string {
    return path.join(rootDir, 'claws', rawClawId);
  }

  /** 在 temp workspace 放一个已发布 active contract（无 .creating marker）。 */
  function publishActiveContract(rawClawId: string, contractId = CONTRACT_ID): void {
    const dir = path.join(clawDirOf(rawClawId), CONTRACT_ACTIVE_DIR, contractId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'contract.yaml'), 'title: test\n');
  }

  /** 放一个未发布（.creating marker 仍在）的 active 候选。 */
  function stageUnpublishedContract(rawClawId: string, contractId = CONTRACT_ID): void {
    const dir = path.join(clawDirOf(rawClawId), CONTRACT_ACTIVE_DIR, contractId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.creating'), '{}');
  }

  interface HarnessOptions {
    clawIds?: string[];
    liveness?: (rawClawId: string) => LivenessResult;
    heartbeat?: (rawClawId: string) => ExecutorHeartbeatRead;
    ensureDaemon?: (rawClawId: string) => Promise<EnsureRunningOutcome>;
    restartDaemon?: (rawClawId: string) => Promise<RestartDaemonResult>;
    resolve?: (clawId: ClawId) => Location;
    enumerate?: () => ClawId[];
    fsFactory?: (baseDir: string) => NodeFileSystem;
  }

  function makeHarness(opts: HarnessOptions = {}) {
    const audits: AuditRecord[] = [];
    const ensureCalls: string[] = [];
    const restartCalls: string[] = [];
    const clawIds = opts.clawIds ?? ['clawA'];
    const topology: Pick<ClawTopology, 'enumerate' | 'resolve'> = {
      enumerate: opts.enumerate ?? (() => clawIds.map(makeClawId)),
      resolve: opts.resolve ?? ((clawId) => ({ kind: 'local', clawDir: clawDirOf(clawId as string) })),
    };
    const deps: ExecutorSupervisorDeps = {
      clawTopology: topology,
      motionClawId: makeClawId('motion'),
      fsFactory: opts.fsFactory ?? ((baseDir) => new NodeFileSystem({ baseDir })),
      audit: { write: (event: string, ...cols: (string | number)[]) => audits.push({ event, cols: cols.map(String) }) },
      liveness: opts.liveness ?? (() => absentLiveness()),
      ensureDaemon: opts.ensureDaemon ?? (async (rawClawId) => {
        ensureCalls.push(rawClawId);
        return { kind: 'spawned', pid: 4242 };
      }),
      restartDaemon: opts.restartDaemon ?? (async (rawClawId) => {
        restartCalls.push(rawClawId);
        return {
          stop: { kind: 'stopped', pid: 4242, via: 'sigterm' },
          ensured: { kind: 'spawned', pid: 4343 },
        };
      }),
      readHeartbeat: opts.heartbeat ?? (() => ({ kind: 'ok', ts: NOW })),
      heartbeatStaleTimeoutMs: STALE_TIMEOUT_MS,
      now: () => NOW,
    };
    return { deps, audits, ensureCalls, restartCalls };
  }

  function findAudit(audits: AuditRecord[], event: string): AuditRecord | undefined {
    return audits.find(a => a.event === event);
  }

  function auditsFor(audits: AuditRecord[], event: string): AuditRecord[] {
    return audits.filter(a => a.event === event);
  }

  // #1 无 active contract → ensure/restart 不调用、不写 audit
  it('无 active contract 的 claw 不 ensure / 不 restart / 无 audit', async () => {
    fs.mkdirSync(clawDirOf('clawA'), { recursive: true });
    const { deps, audits, ensureCalls, restartCalls } = makeHarness();
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual([]);
    expect(restartCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  // #2 active + absent → ensure 1 次，audit ensured trigger=absent outcome=spawned
  it('active + absent → ensure 一次并 audit ensured(trigger=absent, outcome=spawned)', async () => {
    publishActiveContract('clawA');
    const { deps, audits, ensureCalls } = makeHarness({ liveness: () => absentLiveness() });
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual(['clawA']);
    const ensured = findAudit(audits, EV.ENSURED);
    expect(ensured?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', 'trigger=absent', 'outcome=spawned', 'pid=4242']),
    );
  });

  // #3 active + dead → ensure 1 次，trigger=dead
  it('active + dead → ensure 一次并 audit ensured(trigger=dead)', async () => {
    publishActiveContract('clawA');
    const { deps, audits, ensureCalls } = makeHarness({ liveness: () => deadLiveness() });
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual(['clawA']);
    expect(findAudit(audits, EV.ENSURED)?.cols).toContain('trigger=dead');
  });

  // #4 active + alive + 心跳 fresh → 不 ensure / 不 restart / 无 audit
  it('active + alive + 心跳 fresh → 无任何动作', async () => {
    publishActiveContract('clawA');
    const { deps, audits, ensureCalls, restartCalls } = makeHarness({
      liveness: () => aliveLiveness(),
      heartbeat: () => ({ kind: 'ok', ts: NOW - 60_000 }),
    });
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual([]);
    expect(restartCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  // #6 active + alive + heartbeat stale → restart 1 次；stop outcome + ensured audit
  it('active + alive + heartbeat stale → restart 一次并 audit stale + restarted(stop_outcome)', async () => {
    publishActiveContract('clawA');
    const { deps, audits, restartCalls } = makeHarness({
      liveness: () => aliveLiveness(),
      heartbeat: () => ({ kind: 'ok', ts: NOW - STALE_TIMEOUT_MS - 1 }),
    });
    await runExecutorSupervisorTick(deps);
    expect(restartCalls).toEqual(['clawA']);
    expect(findAudit(audits, EV.HEARTBEAT_STALE)?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', `heartbeat_ts=${NOW - STALE_TIMEOUT_MS - 1}`, `now=${NOW}`, `stale_timeout_ms=${STALE_TIMEOUT_MS}`]),
    );
    expect(findAudit(audits, EV.RESTARTED)?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', 'stop_outcome=stopped', 'outcome=spawned', 'pid=4343']),
    );
  });

  it('restart 的 stop failed outcome 不吞：显式记录 stop_outcome=failed', async () => {
    publishActiveContract('clawA');
    const { deps, audits } = makeHarness({
      liveness: () => aliveLiveness(),
      heartbeat: () => ({ kind: 'ok', ts: NOW - STALE_TIMEOUT_MS - 1 }),
      restartDaemon: async () => ({
        stop: { kind: 'failed', stage: 'signal', reason: 'kill EPERM' },
        ensured: { kind: 'spawned', pid: 4343 },
      }),
    });
    await runExecutorSupervisorTick(deps);
    expect(findAudit(audits, EV.RESTARTED)?.cols).toContain('stop_outcome=failed');
  });

  // #7 active + alive + heartbeat missing/corrupt → 不 restart；audit unknown
  it.each(['missing', 'corrupt'] as const)('active + alive + heartbeat %s → 不 restart、audit unknown', async (kind) => {
    publishActiveContract('clawA');
    const { deps, audits, restartCalls, ensureCalls } = makeHarness({
      liveness: () => aliveLiveness(),
      heartbeat: () => ({ kind }),
    });
    await runExecutorSupervisorTick(deps);
    expect(restartCalls).toEqual([]);
    expect(ensureCalls).toEqual([]);
    expect(findAudit(audits, EV.HEARTBEAT_UNKNOWN)?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', `reason=${kind}`]),
    );
  });

  // #8 active + malformed/probe_unavailable → 不 spawn；audit skipped
  it.each([
    ['malformed', () => malformedLiveness()],
    ['probe_unavailable', () => probeUnavailableLiveness()],
  ] as const)('active + %s → 不 spawn、audit skipped(reason=%s)', async (kind, liveness) => {
    publishActiveContract('clawA');
    const { deps, audits, ensureCalls, restartCalls } = makeHarness({ liveness });
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual([]);
    expect(restartCalls).toEqual([]);
    expect(findAudit(audits, EV.SKIPPED)?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', `reason=${kind}`]),
    );
  });

  // #9 ensure 抛错 → audit start_failed；tick 不整体失败
  it('ensure 抛错 → audit start_failed、tick 正常返回', async () => {
    publishActiveContract('clawA');
    const { deps, audits } = makeHarness({
      ensureDaemon: async () => { throw new Error('spawn boom'); },
    });
    await expect(runExecutorSupervisorTick(deps)).resolves.toBeUndefined();
    expect(findAudit(audits, EV.START_FAILED)?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', 'trigger=absent', 'error=spawn boom']),
    );
  });

  it('restart 抛错 → audit restart_failed、tick 正常返回', async () => {
    publishActiveContract('clawA');
    const { deps, audits } = makeHarness({
      liveness: () => aliveLiveness(),
      heartbeat: () => ({ kind: 'ok', ts: NOW - STALE_TIMEOUT_MS - 1 }),
      restartDaemon: async () => { throw new Error('restart boom'); },
    });
    await expect(runExecutorSupervisorTick(deps)).resolves.toBeUndefined();
    expect(findAudit(audits, EV.RESTART_FAILED)?.cols).toContain('claw=clawA');
  });

  // #10 多 claws 部分有契约 → 只处理有契约的；单 claw 失败互不影响
  it('多 claws：只有契约的 absent claw 被 ensure；liveness 抛错的 claw 隔离', async () => {
    publishActiveContract('clawA');
    fs.mkdirSync(clawDirOf('clawB'), { recursive: true }); // 无契约
    publishActiveContract('clawC');
    const { deps, audits, ensureCalls } = makeHarness({
      clawIds: ['clawA', 'clawB', 'clawC'],
      liveness: (rawClawId) => {
        if (rawClawId === 'clawC') throw new Error('probe boom');
        return absentLiveness();
      },
    });
    await expect(runExecutorSupervisorTick(deps)).resolves.toBeUndefined();
    expect(ensureCalls).toEqual(['clawA']);
    expect(findAudit(audits, EV.LIVENESS_PROBE_FAILED)?.cols).toEqual(
      expect.arrayContaining(['claw=clawC', 'error=probe boom']),
    );
    // 无契约的 clawB 不产生任何 audit
    expect(audits.filter(a => a.cols.includes('claw=clawB'))).toEqual([]);
  });

  // #11 topology.enumerate 抛错 → audit scan_failed；正常返回
  it('enumerate 抛错 → audit scan_failed、正常返回', async () => {
    const { deps, audits } = makeHarness({
      enumerate: () => { throw new Error('enumerate boom'); },
    });
    await expect(runExecutorSupervisorTick(deps)).resolves.toBeUndefined();
    expect(findAudit(audits, EV.SCAN_FAILED)?.cols).toEqual(['error=enumerate boom']);
  });

  // #12 listActiveContracts 抛错（单 claw）→ audit contract_scan_failed；跳过该 claw
  it('contract 扫描抛错 → audit contract_scan_failed、跳过该 claw', async () => {
    publishActiveContract('clawA');
    const { deps, audits, ensureCalls } = makeHarness({
      fsFactory: () => { throw new Error('fs boom'); },
    });
    await expect(runExecutorSupervisorTick(deps)).resolves.toBeUndefined();
    expect(ensureCalls).toEqual([]);
    expect(findAudit(audits, EV.CONTRACT_SCAN_FAILED)?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', 'error=fs boom']),
    );
  });

  // #12b topology.resolve 抛错 / 非 local → audit skipped；不 ensure
  it('resolve 抛错 → audit skipped(reason=resolve_failed)、不 ensure', async () => {
    publishActiveContract('clawA');
    const { deps, audits, ensureCalls } = makeHarness({
      resolve: () => { throw new Error('resolve boom'); },
    });
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual([]);
    expect(findAudit(audits, EV.SKIPPED)?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', 'reason=resolve_failed', 'error=resolve boom']),
    );
  });

  it('resolve 非 local → audit skipped(reason=non_local)、不 ensure', async () => {
    publishActiveContract('clawA');
    const { deps, audits, ensureCalls } = makeHarness({
      resolve: () => ({ kind: 'remote' }) as unknown as Location,
    });
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual([]);
    expect(findAudit(audits, EV.SKIPPED)?.cols).toEqual(
      expect.arrayContaining(['claw=clawA', 'reason=non_local']),
    );
  });

  // #13 .creating 未发布契约 → 不算 active
  it('.creating 未发布契约不算 active → 不 ensure、无 audit', async () => {
    stageUnpublishedContract('clawA');
    const { deps, audits, ensureCalls } = makeHarness();
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  // #14 motion 不监督（watchdog 保留 motion daemon 监督）
  it('motion 即使有 active contract 也被跳过（归 watchdog 监督）', async () => {
    publishActiveContract('motion');
    publishActiveContract('clawA');
    const { deps, audits, ensureCalls } = makeHarness({ clawIds: ['motion', 'clawA'] });
    await runExecutorSupervisorTick(deps);
    expect(ensureCalls).toEqual(['clawA']);
    expect(audits.filter(a => a.cols.includes('claw=motion'))).toEqual([]);
  });

  it('abort signal 已 aborted → 不处理任何 claw', async () => {
    publishActiveContract('clawA');
    const controller = new AbortController();
    controller.abort();
    const harness = makeHarness();
    await runExecutorSupervisorTick({ ...harness.deps, signal: controller.signal });
    expect(harness.ensureCalls).toEqual([]);
    expect(harness.audits).toEqual([]);
  });

  describe('createExecutorSupervisorJob descriptor', () => {
    const globalConfig = {
      cron: { jobs: { executor_supervisor: { enabled: true, schedule: 'interval:30s' } } },
    };

    it('name/enabled/schedule/timeout 来自 config', () => {
      const { deps } = makeHarness();
      const job = createExecutorSupervisorJob(deps, globalConfig);
      expect(job.name).toBe('executor-supervisor');
      expect(job.enabled).toBe(true);
      expect(job.schedule).toEqual({ type: 'interval', ms: 30_000 });
      expect(job.timeoutMs).toBe(EXECUTOR_SUPERVISOR_CRON_TIMEOUT_MS);
    });

    it('enabled=false 透传；非法 schedule → null（cron runner 跳过注册）', () => {
      const { deps } = makeHarness();
      const disabled = createExecutorSupervisorJob(deps, {
        cron: { jobs: { executor_supervisor: { enabled: false, schedule: 'interval:30s' } } },
      });
      expect(disabled.enabled).toBe(false);
      const invalid = createExecutorSupervisorJob(deps, {
        cron: { jobs: { executor_supervisor: { enabled: true, schedule: 'daily:25:00' } } },
      });
      expect(invalid.schedule).toBeNull();
    });

    it('handler 调用走 tick（空 workspace 安全返回）', async () => {
      const { deps } = makeHarness({ clawIds: [] });
      const job = createExecutorSupervisorJob(deps, globalConfig);
      await expect(job.handler()).resolves.toBeUndefined();
    });
  });
});
