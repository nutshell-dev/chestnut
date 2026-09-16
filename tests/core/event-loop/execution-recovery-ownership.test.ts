/**
 * Phase 1841: 执行提醒记录按实例归属 —— 真实磁盘多实例验收矩阵。
 *
 * 使用真实 NodeFileSystem / store / controller（不复制调度逻辑）；故障只在
 * Fs 边界用实例级 spy 注入，spy 局部 restore。覆盖：
 * 1. 不同 claw 不同 ID 各自节流，互不改写；无 active 保留所有记录
 * 2. motion 与 worker 同 ID 各自独立；root 不产生新共享记录
 * 3. 单 claw C1→C2→C1 窗口语义；终态记录保留；重建 controller 保持窗口
 * 4. 旧 root 共享基线继承（attempt 3/7、原文/unknown 归属、root 字节不变、
 *    两 claw 同 ID 各自继承后独立推进）
 * 5. 本地优先（legacy spy 抛错也不被调用；attempts=0 本地同样优先）
 * 6. 导入后 activity 前进保存零计数；重启不重导；再次超时开新 epoch
 * 7. local/legacy 严格故障矩阵（EIO / 无效 JSON / 无效 schema / ID 错配 /
 *    坏 provenance / 路径分隔与点段 ID 拒绝 / 真 ENOENT 才首次创建）
 * 8. 写结果：rename 前失败不 enqueue、原字节不变；两种已提交受限耐久性
 *    各只写一次、审计精确类别；到期基线同次「导入+attempt」两写合法
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createExecutionRecoveryStore,
  createExecutionRecoveryController,
  type ExecutionRecoveryController,
  type ExecutionRecoveryDeliveryRequest,
  type ExecutionRecoveryStore,
  type ExecutionActivitySnapshot,
  type ExecutionRecoveryRecord,
} from '../../../src/core/event-loop/execution-recovery.js';
import { EXECUTION_RECOVERY_DIR } from '../../../src/core/event-loop/constants.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const TIMEOUT_MS = 1000;
const BASE_NOW = 1_700_000_000_000;

function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

interface Instance {
  clawId: string;
  agentDir: string;
  agentFs: NodeFileSystem;
  audit: ReturnType<typeof createMockAudit>;
  resumeCalls: ExecutionRecoveryDeliveryRequest[];
  store: ExecutionRecoveryStore;
  controller: ExecutionRecoveryController;
}

describe('execution-recovery ownership (phase 1841)', () => {
  let rootDir: string;
  let rootFs: NodeFileSystem;
  let currentNow: number;

  beforeEach(() => {
    rootDir = createTrackedTempDirSync('execution-recovery-ownership-');
    rootFs = new NodeFileSystem({ baseDir: rootDir });
    currentNow = BASE_NOW;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function localRecordPath(agentDir: string, contractId: string): string {
    return path.join(agentDir, EXECUTION_RECOVERY_DIR, `${contractId}.json`);
  }

  function legacyRecordPath(contractId: string): string {
    return path.join(rootDir, EXECUTION_RECOVERY_DIR, `${contractId}.json`);
  }

  function readLocal(agentDir: string, contractId: string): ExecutionRecoveryRecord | null {
    const p = localRecordPath(agentDir, contractId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ExecutionRecoveryRecord;
  }

  /** 真实 store + controller 的 claw 实例（agentDir 相对路径由调用者给）。 */
  function makeInstance(clawId: string, agentDir: string): Instance {
    fs.mkdirSync(agentDir, { recursive: true });
    const agentFs = new NodeFileSystem({ baseDir: agentDir });
    const audit = createMockAudit();
    const resumeCalls: ExecutionRecoveryDeliveryRequest[] = [];
    const store = createExecutionRecoveryStore({ agentFs, legacyRootFs: rootFs, audit });
    const controller = createExecutionRecoveryController({
      store,
      audit,
      deliverResume: async (request) => { resumeCalls.push(request); return { kind: 'confirmed' as const }; },
      // Phase 1843: 本文件验证实例归属/旧基线语义，不验证 pending 匹配——
      // 显式 absent 模拟依赖（真实 owner 查询能力见 delivery.test.ts）。
      findPendingResume: async () => ({ kind: 'absent' as const }),
      // Phase 1844: 本文件不注入 LLM recovery owner——显式 undefined（未注入语义）。
      inspectLlmRecoverySchedule: async () => undefined,
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
    return { clawId, agentDir, agentFs, audit, resumeCalls, store, controller };
  }

  /** 只重建 controller/store（模拟重启），Fs 与目录不变。 */
  function reopenInstance(inst: Instance): void {
    inst.store = createExecutionRecoveryStore({ agentFs: inst.agentFs, legacyRootFs: rootFs, audit: inst.audit });
    inst.controller = createExecutionRecoveryController({
      store: inst.store,
      audit: inst.audit,
      deliverResume: async (request) => { inst.resumeCalls.push(request); return { kind: 'confirmed' as const }; },
      findPendingResume: async () => ({ kind: 'absent' as const }),
      inspectLlmRecoverySchedule: async () => undefined,
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
  }

  function stalled(contractId: string, lastActivityAt: number): ExecutionActivitySnapshot {
    return {
      activeContractId: contractId,
      lastActivityAt,
      turnInFlight: false,
      retryInFlight: false,
      asyncTaskInFlight: false,
    };
  }

  const IDLE: ExecutionActivitySnapshot = {
    lastActivityAt: 0,
    turnInFlight: false,
    retryInFlight: false,
    asyncTaskInFlight: false,
  };

  function writeLegacyRecord(contractId: string, record: Record<string, unknown>): string {
    const p = legacyRecordPath(contractId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const raw = JSON.stringify(record, null, 2) + '\n';
    fs.writeFileSync(p, raw);
    return raw;
  }

  // -------------------------------------------------------------------------
  // 1. 不同 claw 不同 ID 各自节流
  // -------------------------------------------------------------------------

  it('不同 claw 不同 ID：A→B→A 各 enqueue 一次、互不改写；B 无 active 仍保留全部记录；下一窗口各变 2', async () => {
    const a = makeInstance('claw-a', path.join(rootDir, 'claws', 'claw-a'));
    const b = makeInstance('claw-b', path.join(rootDir, 'claws', 'claw-b'));
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;

    await a.controller.observe(stalled('contract-a', lastActivityAt));
    expect(a.resumeCalls).toHaveLength(1);
    const aBytesAfterFirst = fs.readFileSync(localRecordPath(a.agentDir, 'contract-a'), 'utf8');

    await b.controller.observe(stalled('contract-b', lastActivityAt));
    expect(b.resumeCalls).toHaveLength(1);
    // B 的观察不改写 A 的记录字节
    expect(fs.readFileSync(localRecordPath(a.agentDir, 'contract-a'), 'utf8')).toBe(aBytesAfterFirst);
    expect(readLocal(a.agentDir, 'contract-a')?.attempts).toBe(1);
    expect(readLocal(b.agentDir, 'contract-b')?.attempts).toBe(1);

    // 同窗口 A 重入：不重复
    await a.controller.observe(stalled('contract-a', lastActivityAt));
    expect(a.resumeCalls).toHaveLength(1);

    // B 无 active：不读写，两个 claw 的记录都保留
    const bBytesBefore = fs.readFileSync(localRecordPath(b.agentDir, 'contract-b'), 'utf8');
    const readSpy = vi.spyOn(b.agentFs, 'readSync');
    const writeSpy = vi.spyOn(b.agentFs, 'writeAtomicSync');
    await b.controller.observe(IDLE);
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    writeSpy.mockRestore();
    expect(fs.readFileSync(localRecordPath(b.agentDir, 'contract-b'), 'utf8')).toBe(bBytesBefore);
    expect(fs.readFileSync(localRecordPath(a.agentDir, 'contract-a'), 'utf8')).toBe(aBytesAfterFirst);

    // 下一窗口：各自 2
    currentNow += TIMEOUT_MS;
    await a.controller.observe(stalled('contract-a', lastActivityAt));
    await b.controller.observe(stalled('contract-b', lastActivityAt));
    expect(a.resumeCalls).toHaveLength(2);
    expect(b.resumeCalls).toHaveLength(2);
    expect(readLocal(a.agentDir, 'contract-a')?.attempts).toBe(2);
    expect(readLocal(b.agentDir, 'contract-b')?.attempts).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 2. motion 与 worker 同 ID 各自独立
  // -------------------------------------------------------------------------

  it('motion 与 worker 相同 contract ID：各自本地文件独立节流，root 不产生新共享记录', async () => {
    const motion = makeInstance('motion', path.join(rootDir, 'motion'));
    const worker = makeInstance('worker-1', path.join(rootDir, 'claws', 'worker-1'));
    const contractId = 'shared-contract';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;

    await motion.controller.observe(stalled(contractId, lastActivityAt));
    await worker.controller.observe(stalled(contractId, lastActivityAt));
    expect(motion.resumeCalls).toHaveLength(1);
    expect(worker.resumeCalls).toHaveLength(1);
    // 各自本地文件存在且互不覆盖
    expect(readLocal(motion.agentDir, contractId)?.attempts).toBe(1);
    expect(readLocal(worker.agentDir, contractId)?.attempts).toBe(1);
    // 不存在新 root 共享记录
    expect(fs.existsSync(path.join(rootDir, EXECUTION_RECOVERY_DIR))).toBe(false);

    // worker activity 前进（未超时）→ 零计数；motion 字节不变
    const motionBytes = fs.readFileSync(localRecordPath(motion.agentDir, contractId), 'utf8');
    await worker.controller.observe(stalled(contractId, BASE_NOW));
    expect(readLocal(worker.agentDir, contractId)).toMatchObject({
      observedActivityAt: BASE_NOW,
      attempts: 0,
      lastAttemptAt: 0,
    });
    expect(fs.readFileSync(localRecordPath(motion.agentDir, contractId), 'utf8')).toBe(motionBytes);

    // motion 下一窗口继续自己的计数；worker 不受影响
    currentNow += TIMEOUT_MS;
    await motion.controller.observe(stalled(contractId, lastActivityAt));
    expect(motion.resumeCalls).toHaveLength(2);
    expect(readLocal(motion.agentDir, contractId)?.attempts).toBe(2);
    expect(readLocal(worker.agentDir, contractId)?.attempts).toBe(0);
    expect(fs.existsSync(path.join(rootDir, EXECUTION_RECOVERY_DIR))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. 单 claw C1→C2→C1 与重启
  // -------------------------------------------------------------------------

  it('单 claw C1→C2→C1：同窗口不重复 C1；终态记录保留；重建 controller/store 保持窗口', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const t1 = BASE_NOW - 10 * TIMEOUT_MS;

    await c.controller.observe(stalled('c1', t1));
    expect(c.resumeCalls).toHaveLength(1);
    const c1Bytes = fs.readFileSync(localRecordPath(c.agentDir, 'c1'), 'utf8');

    // 切到 c2：c1 原字节保留，c2 建立自己的记录
    await c.controller.observe(stalled('c2', t1));
    expect(c.resumeCalls).toHaveLength(2);
    expect(fs.readFileSync(localRecordPath(c.agentDir, 'c1'), 'utf8')).toBe(c1Bytes);
    expect(readLocal(c.agentDir, 'c2')?.attempts).toBe(1);

    // 切回 c1（同窗口）：不重复提醒
    await c.controller.observe(stalled('c1', t1));
    expect(c.resumeCalls).toHaveLength(2);
    expect(readLocal(c.agentDir, 'c1')?.attempts).toBe(1);

    // 无 active：不读写任何记录
    const readSpy = vi.spyOn(c.agentFs, 'readSync');
    await c.controller.observe(IDLE);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();

    // 「终态而不再被选中」的记录（此处以 c2 模拟：之后不再被选中）保持原字节
    const c2Bytes = fs.readFileSync(localRecordPath(c.agentDir, 'c2'), 'utf8');

    // 重建 controller/store（模拟重启）：窗口保持——同窗口重入不重复
    reopenInstance(c);
    await c.controller.observe(stalled('c1', t1));
    expect(c.resumeCalls).toHaveLength(2);
    // 窗口到期后继续各自计数
    currentNow += TIMEOUT_MS;
    await c.controller.observe(stalled('c1', t1));
    expect(c.resumeCalls).toHaveLength(3);
    expect(readLocal(c.agentDir, 'c1')?.attempts).toBe(2);
    expect(fs.readFileSync(localRecordPath(c.agentDir, 'c2'), 'utf8')).toBe(c2Bytes);
  });

  // -------------------------------------------------------------------------
  // 4. 旧 root 共享基线继承
  // -------------------------------------------------------------------------

  it('旧 schema1 attempts=3 基线：到期前迁入 local 但不 enqueue；到期后变 4；原文/归属标记准确、root 字节不变', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'legacy-3';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    // 基线窗口未到期：lastAttemptAt 距今 < TIMEOUT_MS
    const legacyRaw = writeLegacyRecord(contractId, {
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 3,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
      // 未知字段随原文保留（不参与投影）
      legacy_note: 'from shared root',
    });

    // 到期前：继承落盘 local，但不 enqueue
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(c.resumeCalls).toHaveLength(0);
    const imported = readLocal(c.agentDir, contractId)!;
    expect(imported).toMatchObject({
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 3,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
    });
    expect(imported.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    // root 原文不变
    expect(fs.readFileSync(legacyRecordPath(contractId), 'utf8')).toBe(legacyRaw);
    // 继承审计
    const importAudit = c.audit.entries.find(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION && e.some(col => String(col) === 'context=executionRecoveryLegacyImport'),
    );
    expect(importAudit).toBeDefined();
    expect(importAudit!.some(col => String(col) === 'source=root_shared')).toBe(true);
    expect(importAudit!.some(col => String(col) === 'attribution=unknown')).toBe(true);

    // 到期后：attempt=4，provenance 保持
    currentNow += TIMEOUT_MS / 2;
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(c.resumeCalls).toHaveLength(1);
    const after = readLocal(c.agentDir, contractId)!;
    expect(after.attempts).toBe(4);
    expect(after.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    expect(fs.readFileSync(legacyRecordPath(contractId), 'utf8')).toBe(legacyRaw);
  });

  it('旧 schema1 attempts=7 基线已到期：同次 observe 合法「导入一次+pending 一次+confirmed 一次」三次业务写，最终 attempt=8（Phase 1842）', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'legacy-7';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    const legacyRaw = writeLegacyRecord(contractId, {
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 7,
      lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
    });
    const writeSpy = vi.spyOn(c.agentFs, 'writeAtomicSync');

    await c.controller.observe(stalled(contractId, lastActivityAt));
    // 导入写 + pending 义务写 + confirmed 写 = 恰好三次业务写（不是盲目重试）：
    // 各次转换 kind 不同但同一冻结 id/attempt
    expect(writeSpy).toHaveBeenCalledTimes(3);
    const writtenKinds = writeSpy.mock.calls.map(call => {
      const parsed = JSON.parse(String(call[1])) as ExecutionRecoveryRecord;
      return parsed.delivery?.kind ?? 'no-delivery';
    });
    expect(writtenKinds).toEqual(['no-delivery', 'pending', 'confirmed']);
    const pendingWrite = JSON.parse(String(writeSpy.mock.calls[1][1])) as ExecutionRecoveryRecord;
    const confirmedWrite = JSON.parse(String(writeSpy.mock.calls[2][1])) as ExecutionRecoveryRecord;
    expect(confirmedWrite.delivery?.id).toBe(pendingWrite.delivery?.id);
    expect(confirmedWrite.delivery?.attempt).toBe(8);
    expect(c.resumeCalls).toHaveLength(1);
    expect(c.resumeCalls[0].delivery.attempt).toBe(8);
    const after = readLocal(c.agentDir, contractId)!;
    expect(after.attempts).toBe(8);
    expect(after.delivery?.kind).toBe('confirmed');
    expect(after.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    expect(fs.readFileSync(legacyRecordPath(contractId), 'utf8')).toBe(legacyRaw);
  });

  it('两 claw 同 ID 继承同一份旧基线原文后独立推进，互不宣称归属', async () => {
    const a = makeInstance('claw-a', path.join(rootDir, 'claws', 'claw-a'));
    const b = makeInstance('claw-b', path.join(rootDir, 'claws', 'claw-b'));
    const contractId = 'legacy-shared';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    const legacyRaw = writeLegacyRecord(contractId, {
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 5,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
    });

    await a.controller.observe(stalled(contractId, lastActivityAt));
    await b.controller.observe(stalled(contractId, lastActivityAt));
    // 均未到期：各自迁入同一份原文，归属均 unknown（不声称旧计数属于任一方）
    const recA = readLocal(a.agentDir, contractId)!;
    const recB = readLocal(b.agentDir, contractId)!;
    expect(recA.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    expect(recB.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    expect(recA.attempts).toBe(5);
    expect(recB.attempts).toBe(5);
    expect(a.resumeCalls).toHaveLength(0);
    expect(b.resumeCalls).toHaveLength(0);

    // 独立推进：A 到期后 6，B activity 前进归零；互不影响
    currentNow += TIMEOUT_MS / 2;
    await a.controller.observe(stalled(contractId, lastActivityAt));
    await b.controller.observe(stalled(contractId, currentNow));
    expect(readLocal(a.agentDir, contractId)?.attempts).toBe(6);
    expect(readLocal(b.agentDir, contractId)).toMatchObject({ attempts: 0, lastAttemptAt: 0 });
    expect(readLocal(b.agentDir, contractId)?.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    // root 原文始终不变
    expect(fs.readFileSync(legacyRecordPath(contractId), 'utf8')).toBe(legacyRaw);
  });

  // -------------------------------------------------------------------------
  // 5. 本地优先
  // -------------------------------------------------------------------------

  it('有本地记录时 legacy 读取不被调用（即使 legacy 读会抛错）；本地 attempts=0 同样优先', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'local-first';
    const lastActivityAt = BASE_NOW - TIMEOUT_MS / 2; // 未超时
    // legacy 与 local 同时存在（local attempts=0 零计数状态）
    writeLegacyRecord(contractId, {
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 9,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
    });
    c.store.save({
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 0,
      lastAttemptAt: 0,
    });
    const legacyReadSpy = vi.spyOn(rootFs, 'readSync').mockImplementation(() => {
      throw new Error('legacy should not be read');
    });

    // 未到期：本地优先，legacy spy 一次都不被调用，零计数状态原样保持
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(legacyReadSpy).not.toHaveBeenCalled();
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(0);
    expect(c.resumeCalls).toHaveLength(0);
    legacyReadSpy.mockRestore();

    // 修改 root 文件后重建 store：本地仍优先（不重新合并旧文件后续变化）
    writeLegacyRecord(contractId, {
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 99,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
    });
    reopenInstance(c);
    const legacyReadSpy2 = vi.spyOn(rootFs, 'readSync');
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(legacyReadSpy2).not.toHaveBeenCalled();
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(0);
    legacyReadSpy2.mockRestore();

    // 窗口到期后：按本地零计数基线登记 attempt1（而非旧 root 的 99+1）
    currentNow += TIMEOUT_MS;
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(1);
    expect(c.resumeCalls[c.resumeCalls.length - 1].delivery.attempt).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. 导入后 activity 前进
  // -------------------------------------------------------------------------

  it('导入后 activity 前进：local 持久零计数/新 observed、provenance 保持；重启不重导；再次超时开新 epoch', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'legacy-progress';
    const t0 = BASE_NOW - 10 * TIMEOUT_MS;
    const legacyRaw = writeLegacyRecord(contractId, {
      schema_version: 1,
      contractId,
      observedActivityAt: t0,
      attempts: 3,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
    });

    // 导入（窗口未到期）
    await c.controller.observe(stalled(contractId, t0));
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(3);

    // activity 前进（未超时）→ 零计数持久化
    const progressedAt = BASE_NOW;
    await c.controller.observe(stalled(contractId, progressedAt));
    const zeroed = readLocal(c.agentDir, contractId)!;
    expect(zeroed).toMatchObject({
      observedActivityAt: progressedAt,
      attempts: 0,
      lastAttemptAt: 0,
    });
    expect(zeroed.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    expect(c.resumeCalls).toHaveLength(0);

    // 重启：旧 root 不会再次覆盖本地状态
    const legacyReadSpy = vi.spyOn(rootFs, 'readSync');
    reopenInstance(c);
    await c.controller.observe(stalled(contractId, progressedAt));
    expect(legacyReadSpy).not.toHaveBeenCalled();
    legacyReadSpy.mockRestore();
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(0);

    // 活动再次超时 → 新 epoch attempt1
    currentNow += TIMEOUT_MS;
    await c.controller.observe(stalled(contractId, progressedAt));
    expect(c.resumeCalls).toHaveLength(1);
    expect(c.resumeCalls[0].delivery.attempt).toBe(1);
    const epoch = readLocal(c.agentDir, contractId)!;
    expect(epoch.attempts).toBe(1);
    expect(epoch.observedActivityAt).toBe(progressedAt);
    expect(epoch.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
  });

  // -------------------------------------------------------------------------
  // 7. 严格故障矩阵
  // -------------------------------------------------------------------------

  function expectFatal(scope: string, reason: string, audit: ReturnType<typeof createMockAudit>): void {
    const fatal = audit.entries.find(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL
        && e.some(col => String(col) === `scope=${scope}`)
        && e.some(col => String(col) === `reason=${reason}`),
    );
    expect(fatal, `FATAL audit scope=${scope} reason=${reason}`).toBeDefined();
  }

  it('local EIO：抛出、不 fallback legacy、原字节不变、无 enqueue', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'c-eio';
    c.store.save({
      schema_version: 1, contractId, observedActivityAt: 1, attempts: 2, lastAttemptAt: 1,
    });
    const bytesBefore = fs.readFileSync(localRecordPath(c.agentDir, contractId), 'utf8');
    const legacyReadSpy = vi.spyOn(rootFs, 'readSync');
    const realRead = c.agentFs.readSync.bind(c.agentFs);
    const readSpy = vi.spyOn(c.agentFs, 'readSync').mockImplementation((p: string) => {
      if (p.includes(contractId)) throw Object.assign(new Error('EIO local'), { code: 'EIO' });
      return realRead(p);
    });

    await expect(c.controller.observe(stalled(contractId, BASE_NOW))).rejects.toThrow('EIO local');
    expect(legacyReadSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(localRecordPath(c.agentDir, contractId), 'utf8')).toBe(bytesBefore);
    expect(c.resumeCalls).toHaveLength(0);
    expectFatal('local', 'read_failed', c.audit);
    readSpy.mockRestore();
    legacyReadSpy.mockRestore();
  });

  it('local 无效 JSON / 无效 schema / ID 错配 / 坏 provenance：抛出、不覆盖、无 enqueue', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    const cases: Array<{ id: string; content: string; reason: string }> = [
      { id: 'bad-json', content: 'not-json{{{', reason: 'parse_failed' },
      { id: 'bad-schema', content: JSON.stringify({ schema_version: 2, contractId: 'bad-schema' }), reason: 'schema_invalid' },
      {
        id: 'id-mismatch',
        content: JSON.stringify({
          schema_version: 1, contractId: 'other-id', observedActivityAt: 1, attempts: 1, lastAttemptAt: 1,
        }),
        reason: 'id_mismatch',
      },
      {
        id: 'bad-provenance',
        content: JSON.stringify({
          schema_version: 1, contractId: 'bad-provenance', observedActivityAt: 1, attempts: 1, lastAttemptAt: 1,
          legacySharedBaseline: { attribution: 'claw-x', raw: '{}' },
        }),
        reason: 'schema_invalid',
      },
    ];
    for (const tc of cases) {
      const p = localRecordPath(c.agentDir, tc.id);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, tc.content);
      const bytesBefore = fs.readFileSync(p, 'utf8');
      await expect(c.controller.observe(stalled(tc.id, lastActivityAt))).rejects.toThrow();
      expect(fs.readFileSync(p, 'utf8')).toBe(bytesBefore);
      expect(c.resumeCalls.filter(r => r.contractId === tc.id)).toHaveLength(0);
      expectFatal('local', tc.reason, c.audit);
    }
  });

  it('legacy EIO / 无效 JSON / 无效 schema / ID 错配：抛出、不建 local、root 原字节不变', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;

    // EIO（非 ENOENT 读取错误）
    const eioId = 'legacy-eio';
    writeLegacyRecord(eioId, {
      schema_version: 1, contractId: eioId, observedActivityAt: 1, attempts: 1, lastAttemptAt: 1,
    });
    const realRootRead = rootFs.readSync.bind(rootFs);
    const readSpy = vi.spyOn(rootFs, 'readSync').mockImplementation((p: string) => {
      if (p.includes(eioId)) throw Object.assign(new Error('EIO legacy'), { code: 'EIO' });
      return realRootRead(p);
    });
    await expect(c.controller.observe(stalled(eioId, lastActivityAt))).rejects.toThrow('EIO legacy');
    expect(fs.existsSync(localRecordPath(c.agentDir, eioId))).toBe(false);
    expect(c.resumeCalls).toHaveLength(0);
    expectFatal('legacy', 'read_failed', c.audit);
    readSpy.mockRestore();

    const cases: Array<{ id: string; content: string; reason: string }> = [
      { id: 'legacy-bad-json', content: 'not-json{{{', reason: 'parse_failed' },
      { id: 'legacy-bad-schema', content: JSON.stringify({ schema_version: 9 }), reason: 'schema_invalid' },
      {
        id: 'legacy-id-mismatch',
        content: JSON.stringify({
          schema_version: 1, contractId: 'someone-else', observedActivityAt: 1, attempts: 1, lastAttemptAt: 1,
        }),
        reason: 'id_mismatch',
      },
    ];
    for (const tc of cases) {
      const p = legacyRecordPath(tc.id);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, tc.content);
      const rootBytesBefore = fs.readFileSync(p, 'utf8');
      await expect(c.controller.observe(stalled(tc.id, lastActivityAt))).rejects.toThrow();
      // 不建 local、不改 root
      expect(fs.existsSync(localRecordPath(c.agentDir, tc.id))).toBe(false);
      expect(fs.readFileSync(p, 'utf8')).toBe(rootBytesBefore);
      expect(c.resumeCalls.filter(r => r.contractId === tc.id)).toHaveLength(0);
      expectFatal('legacy', tc.reason, c.audit);
    }
  });

  it('路径分隔 / 点段 / 空 ID 被拒绝：不能读写实例内其他资源地址', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    // 在实例目录放一个诱饵资源，验证不会被读到
    fs.mkdirSync(path.join(c.agentDir, 'status'), { recursive: true });
    fs.writeFileSync(path.join(c.agentDir, 'status', 'decoy.json'), JSON.stringify({
      schema_version: 1, contractId: 'x', observedActivityAt: 1, attempts: 1, lastAttemptAt: 1,
    }));
    const badIds = ['', '.', '..', '../escape', 'a/b', 'a\\b', 'a\0b', '../../status/decoy'];
    for (const id of badIds) {
      expect(() => c.store.load(id)).toThrow();
      expect(() => c.store.save({
        schema_version: 1, contractId: id, observedActivityAt: 1, attempts: 1, lastAttemptAt: 1,
      })).toThrow();
    }
    // 无任何记录文件被创建；root 侧同样干净
    expect(fs.existsSync(path.join(c.agentDir, EXECUTION_RECOVERY_DIR))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, EXECUTION_RECOVERY_DIR))).toBe(false);
  });

  it('真 ENOENT（local+legacy 均缺）：load 返回 null，到期才首次创建 local', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'brand-new';
    expect(c.store.load(contractId)).toBeNull();
    // 未到期：不建立空状态
    await c.controller.observe(stalled(contractId, BASE_NOW));
    expect(fs.existsSync(localRecordPath(c.agentDir, contractId))).toBe(false);
    expect(c.resumeCalls).toHaveLength(0);
    // 到期：首次实际 save 才建本地文件；root 无新共享记录
    await c.controller.observe(stalled(contractId, BASE_NOW - 10 * TIMEOUT_MS));
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(1);
    expect(fs.existsSync(path.join(rootDir, EXECUTION_RECOVERY_DIR))).toBe(false);
    expect(c.resumeCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 8. 写结果不能丢弃
  // -------------------------------------------------------------------------

  it('导入写 rename 前失败：不返回记录、不 enqueue、root 原字节不变；恢复后正确继承一次', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'import-fail';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    const legacyRaw = writeLegacyRecord(contractId, {
      schema_version: 1, contractId, observedActivityAt: lastActivityAt, attempts: 3,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
    });
    const realWrite = c.agentFs.writeAtomicSync.bind(c.agentFs);
    let fail = true;
    const writeSpy = vi.spyOn(c.agentFs, 'writeAtomicSync').mockImplementation((p, content) => {
      if (fail) throw Object.assign(new Error('EIO rename'), { code: 'EIO' });
      return realWrite(p, content);
    });

    await expect(c.controller.observe(stalled(contractId, lastActivityAt))).rejects.toThrow('EIO rename');
    expect(c.resumeCalls).toHaveLength(0);
    expect(fs.existsSync(localRecordPath(c.agentDir, contractId))).toBe(false);
    expect(fs.readFileSync(legacyRecordPath(contractId), 'utf8')).toBe(legacyRaw);

    // 恢复：继承成功且只写一次（窗口未到期 → 无 attempt 写、无 enqueue）
    fail = false;
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(writeSpy).toHaveBeenCalledTimes(2); // 1 次失败 + 1 次成功
    expect(c.resumeCalls).toHaveLength(0);
    expect(readLocal(c.agentDir, contractId)).toMatchObject({ attempts: 3 });
    writeSpy.mockRestore();
  });

  it('普通 save rename 前失败：不 enqueue、已有本地原字节不变；恢复后正确递增一次', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'save-fail';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    c.store.save({
      schema_version: 1, contractId, observedActivityAt: lastActivityAt, attempts: 2,
      lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
    });
    const bytesBefore = fs.readFileSync(localRecordPath(c.agentDir, contractId), 'utf8');
    const realWrite = c.agentFs.writeAtomicSync.bind(c.agentFs);
    let fail = true;
    vi.spyOn(c.agentFs, 'writeAtomicSync').mockImplementation((p, content) => {
      if (fail) throw Object.assign(new Error('EIO rename'), { code: 'EIO' });
      return realWrite(p, content);
    });

    await expect(c.controller.observe(stalled(contractId, lastActivityAt))).rejects.toThrow('EIO rename');
    expect(c.resumeCalls).toHaveLength(0);
    expect(fs.readFileSync(localRecordPath(c.agentDir, contractId), 'utf8')).toBe(bytesBefore);

    fail = false;
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(c.resumeCalls).toHaveLength(1);
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(3);
  });

  it('activity 重置写失败：旧 record 原字节不变，无新 epoch 提醒', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'reset-fail';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    c.store.save({
      schema_version: 1, contractId, observedActivityAt: lastActivityAt, attempts: 2,
      lastAttemptAt: BASE_NOW - 5 * TIMEOUT_MS,
    });
    const bytesBefore = fs.readFileSync(localRecordPath(c.agentDir, contractId), 'utf8');
    vi.spyOn(c.agentFs, 'writeAtomicSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO reset'), { code: 'EIO' });
    });

    // activity 前进 → 重置写失败 → 抛出；旧记录不变、无 enqueue
    await expect(c.controller.observe(stalled(contractId, BASE_NOW))).rejects.toThrow('EIO reset');
    expect(fs.readFileSync(localRecordPath(c.agentDir, contractId), 'utf8')).toBe(bytesBefore);
    expect(c.resumeCalls).toHaveLength(0);
  });

  it('导入写返回 committed_platform_limited：真实落盘、只写一次、审计精确类别，后续 load 不重导', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'import-limited';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    writeLegacyRecord(contractId, {
      schema_version: 1, contractId, observedActivityAt: lastActivityAt, attempts: 3,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
    });
    const platformError = Object.assign(new Error('fsync not supported'), { code: 'ENOTSUP' });
    const realWrite = c.agentFs.writeAtomicSync.bind(c.agentFs);
    // 先真实落盘，再返回受限结果（不能只有 mock return 却未落盘）
    const writeSpy = vi.spyOn(c.agentFs, 'writeAtomicSync').mockImplementation((p, content) => {
      realWrite(p, content);
      return { kind: 'committed_platform_limited', error: platformError };
    });

    // 窗口未到期：单次导入 load
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(c.resumeCalls).toHaveLength(0);
    // 真实落盘
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(3);
    const fatal = c.audit.entries.find(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL
        && e.some(col => String(col) === 'durability=committed_platform_limited'),
    );
    expect(fatal).toBeDefined();
    expect(fatal!.some(col => String(col) === 'operation=write')).toBe(true);
    expect(fatal!.some(col => String(col).includes('fsync not supported'))).toBe(true);

    // 后续 load：本地权威，不再次导入/重写
    writeSpy.mockRestore();
    const legacyReadSpy = vi.spyOn(rootFs, 'readSync');
    const writeSpy2 = vi.spyOn(c.agentFs, 'writeAtomicSync');
    reopenInstance(c);
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(legacyReadSpy).not.toHaveBeenCalled();
    expect(writeSpy2).not.toHaveBeenCalled();
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(3);
    legacyReadSpy.mockRestore();
    writeSpy2.mockRestore();
  });

  it('普通 save 返回 committed_durability_unknown：真实落盘、pending/confirmed 各一次业务转换、审计精确类别，不重写不加 attempt（Phase 1842）', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'save-unknown';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    c.store.save({
      schema_version: 1, contractId, observedActivityAt: lastActivityAt, attempts: 2,
      lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
    });
    const unknownError = Object.assign(new Error('dir fsync failed'), { code: 'EIO' });
    const realWrite = c.agentFs.writeAtomicSync.bind(c.agentFs);
    const writeSpy = vi.spyOn(c.agentFs, 'writeAtomicSync').mockImplementation((p, content) => {
      realWrite(p, content);
      return { kind: 'committed_durability_unknown', error: unknownError };
    });

    // 到期窗口：pending 登记写 + confirmed 确认写 = 两次业务转换（各有明确 kind，
    // 不是对同一转换的盲目重写）
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(writeSpy).toHaveBeenCalledTimes(2);
    const transitionKinds = writeSpy.mock.calls.map(call =>
      (JSON.parse(String(call[1])) as ExecutionRecoveryRecord).delivery?.kind);
    expect(transitionKinds).toEqual(['pending', 'confirmed']);
    expect(c.resumeCalls).toHaveLength(1);
    expect(c.resumeCalls[0].delivery.attempt).toBe(3);
    // 真实落盘且未被当未提交重写
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(3);
    const fatal = c.audit.entries.find(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL
        && e.some(col => String(col) === 'durability=committed_durability_unknown'),
    );
    expect(fatal).toBeDefined();
    expect(fatal!.some(col => String(col).includes('dir fsync failed'))).toBe(true);

    // 同窗口重入：不重写、不加 attempt（confirmed 后以 confirmedAt 为窗口基线）
    writeSpy.mockRestore();
    const writeSpy2 = vi.spyOn(c.agentFs, 'writeAtomicSync');
    await c.controller.observe(stalled(contractId, lastActivityAt));
    expect(writeSpy2).not.toHaveBeenCalled();
    expect(c.resumeCalls).toHaveLength(1);
    expect(readLocal(c.agentDir, contractId)?.attempts).toBe(3);
    writeSpy2.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 9. Phase 1842: root delivery 不继承义务（显式兼容决策，非静默忽略）
  // -------------------------------------------------------------------------

  it('旧 root 记录含 delivery：不导入为本 claw 义务（本地投影无 delivery），raw 原文原样保留，到期登记全新身份', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'legacy-with-delivery';
    const lastActivityAt = BASE_NOW - 10 * TIMEOUT_MS;
    const legacyRaw = writeLegacyRecord(contractId, {
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 3,
      lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      // 旧共享记录没有实例身份：即便带着格式合法的 delivery，也不能证明本 claw 义务
      delivery: {
        kind: 'pending',
        id: 'execution_recovery-root-legacy',
        attempt: 3,
        scheduledAt: BASE_NOW - 10 * TIMEOUT_MS,
        body: 'legacy body',
      },
    });

    // 到期：继承（投影去掉 delivery）+ 新 pending + confirmed
    await c.controller.observe(stalled(contractId, lastActivityAt));
    const local = readLocal(c.agentDir, contractId)!;
    expect(local.attempts).toBe(4);
    // 新义务身份不是 root delivery 的身份
    expect(local.delivery?.kind).toBe('confirmed');
    expect(local.delivery?.id).not.toBe('execution_recovery-root-legacy');
    expect(c.resumeCalls).toHaveLength(1);
    expect(c.resumeCalls[0].delivery.id).not.toBe('execution_recovery-root-legacy');
    // root 原文（含 delivery 字段）原字节保留为来源证据
    expect(local.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    expect(fs.readFileSync(legacyRecordPath(contractId), 'utf8')).toBe(legacyRaw);
  });

  it('旧 root delivery 格式错误：仍只作原文证据保留、不阻断继承（root 其余格式/ID 错误仍阻断）', async () => {
    const c = makeInstance('claw-c', path.join(rootDir, 'claws', 'claw-c'));
    const contractId = 'legacy-bad-delivery';
    const lastActivityAt = BASE_NOW - TIMEOUT_MS / 2; // 未超时：只导入不登记
    const legacyRaw = writeLegacyRecord(contractId, {
      schema_version: 1,
      contractId,
      observedActivityAt: lastActivityAt,
      attempts: 2,
      lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
      delivery: 12345, // 非法 delivery：不阻断、不继承
    });

    await c.controller.observe(stalled(contractId, lastActivityAt));
    const local = readLocal(c.agentDir, contractId)!;
    expect(local.attempts).toBe(2);
    expect(local.delivery).toBeUndefined();
    expect(local.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    expect(c.resumeCalls).toHaveLength(0);
    expect(fs.readFileSync(legacyRecordPath(contractId), 'utf8')).toBe(legacyRaw);
  });
});
