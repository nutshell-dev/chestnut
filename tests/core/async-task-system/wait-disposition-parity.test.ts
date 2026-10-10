/**
 * Phase 1934 Step D（F-13）：ATS 启动与运行等待处置统一 —— 同一磁盘事实在
 * 启动恢复（recoverTasks）/ ready 唤醒（resumeWaitingTasks）/ deadline 定时器
 * 三入口下得到一致结果的矩阵测试。
 *
 * 覆盖：
 * 1. decideWait 纯判定：deadline 优先于 ready（now >= expiresAt → expired）。
 * 2. 三入口同事实矩阵：resume / keep（gate 未就绪、缺席）/ expired（含 ready
 *    同时发生只失败、缺 gate 仍到期）。
 * 3. 故障注入与重启收敛：resume 意图持久化/move/clear、expired 投递/marker/
 *    terminal intent/move/clear 每个 await 点失败 → 留证可重放，重试收敛。
 * 4. 损坏事实原文保留（不清未知记录；启动 fall through、唤醒不动）；意图字段
 *    严格 schema（坏意图 = corrupt）；旧记录（无意图字段）兼容读取。
 * 5. 真实 executing 任务（有内存句柄）不被扫描驱动。
 * 6. 反向：cancel 后扫描不复活回 pending；keep 路径不改写事实（重启不延长
 *    deadline）；无事实的 running 不动。
 * 7. pending 消费：resume 意图残留须清理完成才执行业务（dispatch 驱动）。
 *
 * 构造惯例 mirror llm-wait-recovery.test.ts / llm-wait-wakeup.test.ts
 * （Map 手实现 FileSystem 子集）；dispatch 驱动用 NodeFileSystem + tempdir
 * （mirror lifecycle-outcome.test.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { LLM_WAIT_FILE, type LLMWaitFact, type LLMWaitGate } from '../../../src/core/async-task-system/llm-wait-state.js';
import { decideWait } from '../../../src/core/async-task-system/wait-disposition.js';
import type { SubAgentTask } from '../../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeTaskSystemDeps, createTestTaskSystem, createMockWatcherFactory } from '../../helpers/task-system.js';
import { makeAudit } from '../../helpers/audit.js';
import { waitFor } from '../../helpers/wait-for.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

const FULL_ID = '550e8400-e29b-41d4-a716-446655440000';

const runningPath = (id: string) => `tasks/queues/running/${id}.json`;
const pendingPath = (id: string) => `tasks/queues/pending/${id}.json`;
const failedPath = (id: string) => `tasks/queues/failed/${id}.json`;
const donePath = (id: string) => `tasks/queues/done/${id}.json`;
const waitPath = (id: string) => `tasks/queues/results/${id}/${LLM_WAIT_FILE}`;
const notifiedPath = (id: string) => `tasks/queues/results/${id}/result.txt.notified`;

function makeValidTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    kind: 'subagent',
    mode: 'standard',
    id: FULL_ID as SubAgentTask['id'],
    shortId: '550e8400' as SubAgentTask['shortId'],
    intent: 'test',
    timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFact(overrides: Partial<LLMWaitFact> = {}): LLMWaitFact {
  const now = Date.now();
  return {
    scope: 'claw-process',
    nextProbeAt: now + 60_000,
    recordedAt: now,
    expiresAt: now + 3_600_000,
    reason: 'All LLM providers failed',
    ...overrides,
  };
}

/** 过期事实：recordedAt/nextProbeAt ≤ expiresAt（严格校验），全取过去时刻。 */
function makeExpiredFact(): LLMWaitFact {
  const now = Date.now();
  return makeFact({ recordedAt: now - 10_000, nextProbeAt: now - 5_000, expiresAt: now - 1_000 });
}

/** Map 手实现 FileSystem 子集（惯例 mirror llm-wait-recovery.test.ts）。 */
function makeMapFs(seed: Record<string, string> = {}): { fs: FileSystem; fileMap: Map<string, string> } {
  const fileMap = new Map<string, string>(Object.entries(seed));
  const fs = {
    list: vi.fn().mockImplementation((dir: string) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const entries: Array<{ name: string; path: string }> = [];
      for (const p of fileMap.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (!rest.includes('/')) entries.push({ name: rest, path: p });
        }
      }
      return Promise.resolve(entries);
    }),
    read: vi.fn().mockImplementation((p: string) => {
      const content = fileMap.get(p);
      if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve(content);
    }),
    move: vi.fn().mockImplementation((from: string, to: string) => {
      const content = fileMap.get(from);
      if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      fileMap.delete(from);
      fileMap.set(to, content);
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation((p: string) => {
      if (!fileMap.has(p)) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      fileMap.delete(p);
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((p: string, content: string) => {
      fileMap.set(p, content);
      return Promise.resolve(undefined);
    }),
    exists: vi.fn().mockImplementation((p: string) => Promise.resolve(fileMap.has(p))),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    ensureDirSync: vi.fn(),
    appendSync: vi.fn(),
    resolve: (p: string) => p,
  } as unknown as FileSystem;
  return { fs, fileMap };
}

function runningTaskSeed(task: SubAgentTask, extraFiles: Record<string, string> = {}): Record<string, string> {
  return {
    [runningPath(task.id)]: JSON.stringify(task),
    ...extraFiles,
  };
}

/** 旧记录兼容形态：无 resumeIntent 字段（Phase 1933 持久化的事实）。 */
function waitFileSeed(task: SubAgentTask, fact: LLMWaitFact): Record<string, string> {
  return {
    [waitPath(task.id)]: JSON.stringify({ schema_version: 1, ...fact }),
  };
}

function hasEvent(
  events: Array<[string, ...(string | number)[]]>,
  type: string,
  colIncludes?: string,
): boolean {
  return events.some(e => e[0] === type
    && (colIncludes === undefined || e.some(c => typeof c === 'string' && c.includes(colIncludes))));
}

function countEvent(events: Array<[string, ...(string | number)[]]>, type: string): number {
  return events.filter(e => e[0] === type).length;
}

// ─── 三入口驱动 ─────────────────────────────────────────────────────────────

const ENTRIES = ['startup', 'ready'] as const;
type Entry = (typeof ENTRIES)[number];

interface EntryCtx {
  fs: FileSystem;
  audit: AuditLog;
  gate?: LLMWaitGate;
  sendFallbackResult?: RecoverTasksDeps['sendFallbackResult'];
}

interface EntryHandle {
  /** 同入口重放（模拟重启后再次恢复 / 再次 ready 信号）。 */
  rerun: () => Promise<void>;
  system?: AsyncTaskSystem;
}

async function runEntry(entry: Entry, ctx: EntryCtx): Promise<EntryHandle> {
  if (entry === 'startup') {
    const deps: RecoverTasksDeps = {
      fs: ctx.fs,
      auditWriter: ctx.audit,
      sendResult: vi.fn().mockResolvedValue({ kind: 'delivered' }),
      sendFallbackResult: ctx.sendFallbackResult ?? vi.fn().mockResolvedValue({ kind: 'delivered' }),
      sendToolResult: vi.fn().mockResolvedValue({ kind: 'delivered' }),
      ...(ctx.gate ? { waitGate: ctx.gate } : {}),
    };
    await recoverTasks(deps);
    return { rerun: async () => { await recoverTasks(deps); } };
  }
  const system = new AsyncTaskSystem('/tmp/claw', ctx.fs, {
    shortIdIndex: new InMemoryShortIdIndex(),
    auditWriter: ctx.audit,
    ...makeTaskSystemDeps(),
    ...(ctx.gate ? { waitGate: ctx.gate } : {}),
    ...(ctx.sendFallbackResult ? { sendFallbackResult: ctx.sendFallbackResult } : {}),
  });
  // 不调 initialize：本入口直接驱动 resumeWaitingTasks（mirror Step F 既有用例）。
  await system.resumeWaitingTasks();
  return {
    rerun: async () => { await system.resumeWaitingTasks(); },
    system,
  };
}

async function cleanupHandle(handle: EntryHandle): Promise<void> {
  await handle.system?.shutdown(1).catch(() => { /* silent: teardown */ });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 1. decideWait 纯判定 ───────────────────────────────────────────────────
describe('decideWait 纯判定：deadline 优先于 ready', () => {
  it('now >= expiresAt → expired（到点即到期，与 ready 无关）', () => {
    expect(decideWait(100, 100, true)).toBe('expired');
    expect(decideWait(100, 100, false)).toBe('expired');
    expect(decideWait(101, 100, true)).toBe('expired');
  });

  it('未到期：ready → resume；未 ready → keep', () => {
    expect(decideWait(99, 100, true)).toBe('resume');
    expect(decideWait(99, 100, false)).toBe('keep');
  });
});

// ─── 2. 启动恢复 + ready 唤醒：同事实矩阵 ───────────────────────────────────
describe('同事实矩阵：startup recovery / ready wakeup 两入口一致', () => {
  it.each(ENTRIES)('%s：gate ready + 未到期 → resume 回 pending、事实清除、不投递', async (entry) => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => true }, sendFallbackResult });

    expect(fileMap.has(pendingPath(task.id))).toBe(true);
    expect(fileMap.has(runningPath(task.id))).toBe(false);
    expect(fileMap.has(waitPath(task.id))).toBe(false);
    expect(fileMap.has(failedPath(task.id))).toBe(false);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(1);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(0);
    expect(sendFallbackResult).not.toHaveBeenCalled();
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：gate 未就绪 + 未到期 → keep：留 running、事实原文不变（不延长 deadline）', async (entry) => {
    const task = makeValidTask();
    const fact = makeFact();
    const seed = runningTaskSeed(task, waitFileSeed(task, fact));
    const factBytes = seed[waitPath(task.id)];
    const { fs, fileMap } = makeMapFs(seed);
    const { audit, events } = makeAudit();

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => false } });

    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    // keep 路径不改写事实：字节级不变（重启/扫描不延长 deadline、不添加字段）
    expect(fileMap.get(waitPath(task.id))).toBe(factBytes);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_CONTINUED, 'reason=gate_not_ready')).toBe(true);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：gate 缺席 + 未到期 → keep（reason=gate_absent）', async (entry) => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();

    const handle = await runEntry(entry, { fs, audit });

    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    expect(fileMap.has(waitPath(task.id))).toBe(true);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_CONTINUED, 'reason=gate_absent')).toBe(true);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：过期 + gate 未就绪 → failed（投递 + terminal intent + 清事实）', async (entry) => {
    const task = makeValidTask();
    const fact = makeExpiredFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => false }, sendFallbackResult });

    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(fileMap.has(runningPath(task.id))).toBe(false);
    expect(fileMap.has(pendingPath(task.id))).toBe(false);
    expect(fileMap.has(donePath(task.id))).toBe(false);
    expect(fileMap.has(waitPath(task.id))).toBe(false);
    // 既有失败协议：投递（isError envelope）+ notified marker + terminalState intent
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    expect((sendFallbackResult.mock.calls[0][3] as { isError: boolean }).isError).toBe(true);
    expect(fileMap.has(notifiedPath(task.id))).toBe(true);
    const failedTask = JSON.parse(fileMap.get(failedPath(task.id))!) as Record<string, unknown>;
    expect(failedTask.terminalState).toBe('failed');
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(1);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(0);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：过期 + gate ready 同时发生 → 只失败（不 resume、不回 pending）', async (entry) => {
    const task = makeValidTask();
    const fact = makeExpiredFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => true }, sendFallbackResult });

    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(fileMap.has(pendingPath(task.id))).toBe(false);
    expect(fileMap.has(donePath(task.id))).toBe(false);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(1);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(0);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：过期 + gate 缺席 → deadline 仍可到期（缺 gate 不阻塞到期处置）', async (entry) => {
    const task = makeValidTask();
    const fact = makeExpiredFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });

    const handle = await runEntry(entry, { fs, audit, sendFallbackResult });

    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(fileMap.has(runningPath(task.id))).toBe(false);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(1);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：无等待事实的 running 任务 → 不受影响（startup 走既有分支回 pending / ready 不动）', async (entry) => {
    const task = makeValidTask();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task));
    const { audit, events } = makeAudit();

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => true } });

    // 两入口都不做等待处置（无 RESUMED/CONTINUED/EXPIRED）；
    // startup 既有分支回 pending，ready 不动——均非等待语义。
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(0);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_CONTINUED)).toBe(0);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(0);
    if (entry === 'startup') {
      expect(fileMap.has(pendingPath(task.id))).toBe(true);
    } else {
      expect(fs.move).not.toHaveBeenCalled();
      expect(fileMap.has(runningPath(task.id))).toBe(true);
    }
    await cleanupHandle(handle);
  });
});

// ─── 3. deadline 定时器入口（进程内到期处置） ───────────────────────────────
describe('deadline 定时器入口：startup 重建等待订阅，到期由 ATS 安排检查', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = () => vi.advanceTimersByTimeAsync(0);

  function makeTimerSystem(
    fs: FileSystem,
    audit: AuditLog,
    gate: LLMWaitGate,
    sendFallbackResult: RecoverTasksDeps['sendFallbackResult'],
  ): AsyncTaskSystem {
    return new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      waitGate: gate,
      ...(sendFallbackResult ? { sendFallbackResult } : {}),
    });
  }

  it('gate 始终未就绪：initialize 保持 waiting + 安排到期检查；到期 → failed（不等重启）', async () => {
    const t0 = Date.now();
    const task = makeValidTask();
    const fact = makeFact({ recordedAt: t0, nextProbeAt: t0, expiresAt: t0 + 60_000 });
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });
    const system = makeTimerSystem(fs, audit, { canResume: () => false }, sendFallbackResult);

    await system.initialize();
    // 未到期：startup 恢复保持 waiting，任务/事实不动
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    expect(fileMap.has(waitPath(task.id))).toBe(true);

    // ATS 按本任务 expiresAt 安排的定时检查触发到期处置
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    await flush();
    await flush();

    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(fileMap.has(runningPath(task.id))).toBe(false);
    expect(fileMap.has(pendingPath(task.id))).toBe(false);
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(1);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(0);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });

  it('到期时 gate 已 ready：deadline 优先 → failed，不 resume 不回 pending', async () => {
    const t0 = Date.now();
    const task = makeValidTask();
    const fact = makeFact({ recordedAt: t0, nextProbeAt: t0, expiresAt: t0 + 60_000 });
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });
    let ready = false;
    const system = makeTimerSystem(fs, audit, { canResume: () => ready }, sendFallbackResult);

    await system.initialize();
    expect(fileMap.has(runningPath(task.id))).toBe(true);

    // 到期前 ready：进程内 ready 信号唤醒回 pending 是 Step C 路径；本用例直接
    // 推进到 deadline（模拟 ready 信号未及时到达）——deadline 优先于 ready。
    ready = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    await flush();
    await flush();

    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(fileMap.has(pendingPath(task.id))).toBe(false);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(1);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(0);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 4. 故障注入与重启收敛（每个 await 点） ─────────────────────────────────
describe('故障注入 → 留证可重放、重试收敛', () => {
  /** writeAtomic 对指定路径后缀第一次调用注入失败。 */
  function failWriteAtomicOnce(fs: FileSystem, pathSuffix: string): void {
    const real = fs.writeAtomic.bind(fs);
    let failed = false;
    fs.writeAtomic = vi.fn().mockImplementation(async (p: string, content: string) => {
      if (!failed && p.endsWith(pathSuffix)) {
        failed = true;
        throw new Error('EIO write boom');
      }
      return real(p, content);
    }) as FileSystem['writeAtomic'];
  }

  /** move 对指定来源后缀第一次调用注入非 ENOENT 失败。 */
  function failMoveOnce(fs: FileSystem, fromSuffix: string): void {
    const real = fs.move.bind(fs);
    let failed = false;
    fs.move = vi.fn().mockImplementation(async (from: string, to: string) => {
      if (!failed && from.endsWith(fromSuffix)) {
        failed = true;
        throw new Error('EIO move boom');
      }
      return real(from, to);
    }) as FileSystem['move'];
  }

  /** delete 对 llm-wait.json 持续注入失败。 */
  function failWaitDelete(fs: FileSystem): void {
    const real = fs.delete.bind(fs);
    fs.delete = vi.fn().mockImplementation(async (p: string) => {
      if (p.endsWith(LLM_WAIT_FILE)) throw new Error('EIO delete boom');
      return real(p);
    }) as FileSystem['delete'];
  }

  it.each(ENTRIES)('%s：resume 意图持久化失败 → 不 move（不丢等待身份）、事实无意图；重试收敛', async (entry) => {
    const task = makeValidTask();
    const fact = makeFact();
    const seed = runningTaskSeed(task, waitFileSeed(task, fact));
    const factBytes = seed[waitPath(task.id)];
    const { fs, fileMap } = makeMapFs(seed);
    const { audit, events } = makeAudit();
    failWriteAtomicOnce(fs, LLM_WAIT_FILE);

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => true } });

    // 意图未持久化 → 不 move；事实原样（无意图字段）；audit 留证
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    expect(fileMap.has(pendingPath(task.id))).toBe(false);
    expect(fileMap.get(waitPath(task.id))).toBe(factBytes);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_resume_intent_failed')).toBe(true);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(0);

    // 重试（模拟重启后再次进入同入口）→ 收敛
    await handle.rerun();
    expect(fileMap.has(pendingPath(task.id))).toBe(true);
    expect(fileMap.has(waitPath(task.id))).toBe(false);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(1);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：resume move 失败 → 意图保留（等待身份不丢、deadline 不延长）；重试收敛', async (entry) => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    failMoveOnce(fs, runningPath(task.id));

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => true } });

    // move 失败 → 任务留 running；事实保留且带可重放迁移意图；expiresAt 不重置
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    expect(fileMap.has(pendingPath(task.id))).toBe(false);
    const retained = JSON.parse(fileMap.get(waitPath(task.id))!) as Record<string, unknown>;
    expect(retained.expiresAt).toBe(fact.expiresAt);
    expect((retained.resumeIntent as { target: string }).target).toBe('pending');
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_resume_move_failed')).toBe(true);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(0);

    // 重试：按意图重放 move → 收敛（事实清除）
    await handle.rerun();
    expect(fileMap.has(pendingPath(task.id))).toBe(true);
    expect(fileMap.has(runningPath(task.id))).toBe(false);
    expect(fileMap.has(waitPath(task.id))).toBe(false);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(1);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：resume clear 失败 → 任务已回 pending、意图残留留证（清理归 pending 消费）', async (entry) => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    failWaitDelete(fs);

    await runEntry(entry, { fs, audit, gate: { canResume: () => true } });

    // move 已成功（处置完成）；事实清理失败 → 留证（含意图），由 pending 消费方清理
    expect(fileMap.has(pendingPath(task.id))).toBe(true);
    expect(fileMap.has(runningPath(task.id))).toBe(false);
    const retained = JSON.parse(fileMap.get(waitPath(task.id))!) as Record<string, unknown>;
    expect((retained.resumeIntent as { target: string }).target).toBe('pending');
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_resume_clear_failed')).toBe(true);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(1);
  });

  it.each(ENTRIES)('%s：expired 投递失败 → 留 running 待重试、不写 marker；重试收敛', async (entry) => {
    const task = makeValidTask();
    const fact = makeExpiredFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn()
      .mockRejectedValueOnce(new Error('notify boom'))
      .mockResolvedValue({ kind: 'delivered' });

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => true }, sendFallbackResult });

    // 投递失败 → 不终态、不写 marker（防重启漏投）、任务留 running、事实保留
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    expect(fileMap.has(failedPath(task.id))).toBe(false);
    expect(fileMap.has(notifiedPath(task.id))).toBe(false);
    expect(fileMap.has(waitPath(task.id))).toBe(true);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_expired_notify_failed')).toBe(true);

    // 重试 → 收敛 failed（投递重试一次）
    await handle.rerun();
    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(fileMap.has(waitPath(task.id))).toBe(false);
    expect(sendFallbackResult).toHaveBeenCalledTimes(2);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：expired terminal intent 写失败 → 留 running（marker 已在）；重试不重复投递', async (entry) => {
    const task = makeValidTask();
    const fact = makeExpiredFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });
    failWriteAtomicOnce(fs, runningPath(task.id));

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => true }, sendFallbackResult });

    // 投递+marker 已完成，terminal intent 失败 → 不 move；留证
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    expect(fileMap.has(notifiedPath(task.id))).toBe(true);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_expired_terminal_intent_failed')).toBe(true);

    // 重试：marker 存在 → 跳过投递（幂等）；terminal intent + move 收敛
    await handle.rerun();
    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：expired move 失败 → terminal intent 路由 + marker 幂等；重试收敛不重复投递', async (entry) => {
    const task = makeValidTask();
    const fact = makeExpiredFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });
    failMoveOnce(fs, runningPath(task.id));

    const handle = await runEntry(entry, { fs, audit, gate: { canResume: () => true }, sendFallbackResult });

    // move 失败 → 任务留 running 且带 terminal intent（恢复路由不依赖事实是否在）
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    const runningTask = JSON.parse(fileMap.get(runningPath(task.id))!) as Record<string, unknown>;
    expect(runningTask.terminalState).toBe('failed');
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_expired_move_failed')).toBe(true);

    await handle.rerun();
    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(fileMap.has(waitPath(task.id))).toBe(false);
    // marker 保证投递恰好一次
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    await cleanupHandle(handle);
  });

  it.each(ENTRIES)('%s：expired clear 失败 → 任务已 failed、事实保留作证据', async (entry) => {
    const task = makeValidTask();
    const fact = makeExpiredFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit, events } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });
    failWaitDelete(fs);

    await runEntry(entry, { fs, audit, gate: { canResume: () => true }, sendFallbackResult });

    // 终态已达成（failed）；事实清理失败仅留证（任务已离开 running，恢复不再触碰）
    expect(fileMap.has(failedPath(task.id))).toBe(true);
    expect(fileMap.has(runningPath(task.id))).toBe(false);
    expect(fileMap.has(waitPath(task.id))).toBe(true);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_expired_clear_failed')).toBe(true);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(1);
  });
});

// ─── 5. 损坏与兼容 ──────────────────────────────────────────────────────────
describe('损坏事实与意图 schema：原文保留（不清未知记录）', () => {
  it('startup：坏 JSON → 留证 + 原文保留 + fall through 既有分支（回 pending）', async () => {
    const task = makeValidTask();
    const corruptContent = '{not valid json';
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, {
      [waitPath(task.id)]: corruptContent,
    }));
    const { audit, events } = makeAudit();

    const handle = await runEntry('startup', { fs, audit, gate: { canResume: () => false } });

    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_corrupt')).toBe(true);
    // 损坏不删除：原文保留（防死循环由 fall through 后任务离开 running 保证）
    expect(fileMap.get(waitPath(task.id))).toBe(corruptContent);
    // fall through 既有分支：无 terminalState/结果 → 回 pending 重执行
    expect(fileMap.has(pendingPath(task.id))).toBe(true);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(0);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_EXPIRED)).toBe(0);
    await cleanupHandle(handle);
  });

  it('ready：坏 JSON → 留证、不动不删（fall through 处置归重启恢复分支）', async () => {
    const task = makeValidTask();
    const corruptContent = '{not valid json';
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, {
      [waitPath(task.id)]: corruptContent,
    }));
    const { audit, events } = makeAudit();

    const handle = await runEntry('ready', { fs, audit, gate: { canResume: () => true } });

    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    expect(fileMap.get(waitPath(task.id))).toBe(corruptContent);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_wakeup_fact_corrupt')).toBe(true);
    await cleanupHandle(handle);
  });

  it('意图字段严格 schema：非法 resumeIntent → 整份记录 corrupt（不动不删不猜）', async () => {
    const task = makeValidTask();
    const fact = makeFact();
    const badIntent = JSON.stringify({
      schema_version: 1,
      ...fact,
      resumeIntent: { target: 'done', decidedAt: fact.recordedAt },
    });
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, {
      [waitPath(task.id)]: badIntent,
    }));
    const { audit, events } = makeAudit();

    const handle = await runEntry('ready', { fs, audit, gate: { canResume: () => true } });

    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.get(waitPath(task.id))).toBe(badIntent);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'context=llm_wait_wakeup_fact_corrupt')).toBe(true);
    await cleanupHandle(handle);
  });

  it('旧记录兼容：无 resumeIntent 字段的事实正常读取与处置（resume）', async () => {
    const task = makeValidTask();
    const fact = makeFact();
    // 显式构造 Phase 1933 旧形态（无 resumeIntent 键）
    const legacy = {
      schema_version: 1,
      scope: fact.scope,
      nextProbeAt: fact.nextProbeAt,
      recordedAt: fact.recordedAt,
      expiresAt: fact.expiresAt,
      reason: fact.reason,
    };
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, {
      [waitPath(task.id)]: JSON.stringify(legacy),
    }));
    const { audit, events } = makeAudit();

    const handle = await runEntry('startup', { fs, audit, gate: { canResume: () => true } });

    expect(fileMap.has(pendingPath(task.id))).toBe(true);
    expect(fileMap.has(waitPath(task.id))).toBe(false);
    expect(countEvent(events, TASK_AUDIT_EVENTS.TASK_LLM_WAIT_RESUMED)).toBe(1);
    await cleanupHandle(handle);
  });
});

// ─── 6. 真实 executing 任务不受扫描影响 ─────────────────────────────────────
describe('扫描只驱动等待任务：真实 executing 任务（有内存句柄）不受影响', () => {
  it('running 有事实但有内存执行句柄 → ready 扫描跳过（不 move、不改事实）', async () => {
    const task = makeValidTask();
    const fact = makeFact();
    const seed = runningTaskSeed(task, waitFileSeed(task, fact));
    const factBytes = seed[waitPath(task.id)];
    const { fs, fileMap } = makeMapFs(seed);
    const { audit } = makeAudit();
    const system = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      waitGate: { canResume: () => true },
    });
    // 构造真实执行中形态：内存句柄存在（等待任务的句柄在 executor 返回后已移除）
    type ExecutingMap = Map<string, { abortController: AbortController; promise: Promise<void> }>;
    const handles = (system as unknown as { executingTasks: ExecutingMap }).executingTasks;
    let settle!: () => void;
    handles.set(task.id, {
      abortController: new AbortController(),
      promise: new Promise<void>(r => { settle = r; }),
    });

    const resumed = await system.resumeWaitingTasks();

    expect(resumed).toBe(0);
    expect(fs.move).not.toHaveBeenCalled();
    expect(fileMap.has(runningPath(task.id))).toBe(true);
    expect(fileMap.get(waitPath(task.id))).toBe(factBytes);

    settle();
    handles.delete(task.id);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 7. 反向：cancel 后扫描不复活 ───────────────────────────────────────────
describe('取消竞争不复活任务', () => {
  it('waiting 任务 cancel → failed；之后 ready 扫描不回 pending', async () => {
    const task = makeValidTask();
    const fact = makeFact();
    const { fs, fileMap } = makeMapFs(runningTaskSeed(task, waitFileSeed(task, fact)));
    const { audit } = makeAudit();
    const sendFallbackResult = vi.fn().mockResolvedValue({ kind: 'delivered' });
    const system = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      waitGate: { canResume: () => true },
      sendFallbackResult,
    });

    const outcome = await system.cancelDetailed(task.id);
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind === 'cancelled') {
      expect(outcome.from).toBe('running_waiting');
    }
    expect(fileMap.has(failedPath(task.id))).toBe(true);

    // 取消后 ready 扫描：任务已离开 running，不得复活回 pending
    const resumed = await system.resumeWaitingTasks();
    expect(resumed).toBe(0);
    expect(fileMap.has(pendingPath(task.id))).toBe(false);
    expect(fileMap.has(failedPath(task.id))).toBe(true);
    await system.shutdown(1).catch(() => { /* silent: teardown */ });
  });
});

// ─── 8. pending 消费：resume 意图清理完成才执行业务（dispatch 驱动） ────────
describe('pending 消费确认 resume 意图清理完成再执行业务', () => {
  let tempDir: string | undefined;
  let system: AsyncTaskSystem | undefined;

  afterEach(async () => {
    await system?.shutdown(1).catch(() => { /* silent: teardown */ });
    system = undefined;
    if (tempDir) await cleanupTempDir(tempDir);
    tempDir = undefined;
  });

  async function seedPendingWithIntent(opts?: { clearFails?: boolean }) {
    tempDir = await createTempDir();
    const fs = new NodeFileSystem({ baseDir: tempDir });
    const { factory: createWatcher } = createMockWatcherFactory(fs);
    const task = makeValidTask();
    const now = Date.now();
    const fact = makeFact({ recordedAt: now, nextProbeAt: now, expiresAt: now + 3_600_000 });
    await fs.ensureDir('tasks/queues/pending');
    await fs.ensureDir(`tasks/queues/results/${task.id}`);
    // 崩溃窗口形态：move 已成功（任务在 pending）但清事实失败 → 意图残留
    await fs.writeAtomic(pendingPath(task.id), JSON.stringify(task));
    await fs.writeAtomic(waitPath(task.id), JSON.stringify({
      schema_version: 1,
      ...fact,
      resumeIntent: { target: 'pending', decidedAt: now },
    }));

    let restoreDelete: (() => void) | undefined;
    if (opts?.clearFails) {
      const realDelete = fs.delete.bind(fs);
      fs.delete = (async (p: string) => {
        if (p.endsWith(LLM_WAIT_FILE)) throw new Error('EIO delete boom');
        return realDelete(p);
      }) as FileSystem['delete'];
      restoreDelete = () => { fs.delete = realDelete; };
    }

    const { audit, events } = makeAudit();
    let factPresentAtExec: boolean | undefined;
    const exec = vi.fn().mockImplementation(async () => {
      // 业务执行起点观察：意图清理必须先完成
      factPresentAtExec = await fs.exists(waitPath(task.id));
      return { content: 'ok', sourceIsError: false };
    });
    const sys = createTestTaskSystem(tempDir, fs, audit, undefined, {
      createWatcher,
      taskExecutor: { execute: exec } as never,
      deliverySink: { deliver: vi.fn().mockResolvedValue({ kind: 'delivered' }) } as never,
    });
    system = sys;
    return {
      fs, task, events, exec, sys, restoreDelete,
      getFactPresentAtExec: () => factPresentAtExec,
    };
  }

  it('意图残留：dispatch 前清理完成 → 业务执行时事实已清、任务跑完到 done', async () => {
    const { fs, task, exec, sys, getFactPresentAtExec } = await seedPendingWithIntent();
    await sys.initialize();
    await sys.startDispatch();

    await waitFor(() => getFactPresentAtExec() !== undefined);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(getFactPresentAtExec()).toBe(false);
    expect(await fs.exists(waitPath(task.id))).toBe(false);
    await waitFor(() => fs.exists(donePath(task.id)));
  });

  it('意图清理失败 → 本轮不执行业务（留 pending）；清理恢复 + 重信号 → 执行', async () => {
    const { fs, task, events, exec, sys, restoreDelete } = await seedPendingWithIntent({ clearFails: true });
    await sys.initialize();
    await sys.startDispatch();

    // 清理持续失败：业务不得执行，任务留 pending，audit 留证
    await new Promise(r => setTimeout(r, 300));
    expect(exec).not.toHaveBeenCalled();
    expect(await fs.exists(pendingPath(task.id))).toBe(true);
    expect(hasEvent(events, TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'pending_wait_intent_clear_failed')).toBe(true);

    // 清理恢复 + 重新信号（mock watcher 对 pending 写入触发 ingest）
    restoreDelete!();
    const content = await fs.read(pendingPath(task.id));
    await fs.writeAtomic(pendingPath(task.id), content);

    await waitFor(() => exec.mock.calls.length === 1);
    expect(await fs.exists(waitPath(task.id))).toBe(false);
  });
});
