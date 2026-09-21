/**
 * Phase 1869 Step F：提醒状态变迁证据链（write-ahead + supersede 独立事件）。
 *
 * 契约：
 * - 每类状态变迁（epoch reset / 新登记 / 交付确认）审计事件先于状态覆盖写，
 *   载荷含将写入全量 record（next_record；reset 另含 previous_record）；
 * - 崩溃窗口方向 = 「审计有、状态未前移」：重启以状态文件为权威、下一 tick
 *   重推同变迁收敛到唯一当前态（孤儿意图行可发现，不产生物理写）；
 * - supersede 为交付级独立变迁（独立事件承载 delivery_id），不再只内嵌 reset 载荷；
 * - 正常路径 next_record 与磁盘 record 逐字一致（状态级可重建）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  createExecutionRecoveryStore,
  createExecutionRecoveryController,
  type ExecutionRecoveryController,
  type ExecutionRecoveryDeliveryOutcome,
  type ExecutionRecoveryDeliveryRequest,
  type ExecutionRecoveryStore,
  type ExecutionActivitySnapshot,
  type ExecutionRecoveryRecord,
} from '../../../src/core/event-loop/execution-recovery.js';
import { EXECUTION_RECOVERY_DIR } from '../../../src/core/event-loop/constants.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

const TIMEOUT_MS = 1000;
const BASE_NOW = 1_700_000_000_000;
const CONTRACT_ID = '1700000000000-abcd';

function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

describe('phase 1869 Step F: 变迁证据链（write-ahead）', () => {
  let rootDir: string;
  let agentDir: string;
  let agentFs: NodeFileSystem;
  let audit: ReturnType<typeof createMockAudit>;
  let currentNow: number;
  let resumeCalls: ExecutionRecoveryDeliveryRequest[];
  let nextOutcome: ExecutionRecoveryDeliveryOutcome;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    rootDir = path.join(os.tmpdir(), `transition-evidence-${randomUUID()}`);
    agentDir = path.join(rootDir, 'claws', 'claw-1');
    fs.mkdirSync(agentDir, { recursive: true });
    agentFs = new NodeFileSystem({ baseDir: agentDir });
    audit = createMockAudit();
    currentNow = BASE_NOW;
    resumeCalls = [];
    nextOutcome = { kind: 'confirmed' };
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function recordFilePath(contractId: string): string {
    return path.join(agentDir, EXECUTION_RECOVERY_DIR, `${contractId}.json`);
  }

  function readRecordFile(contractId: string): ExecutionRecoveryRecord | null {
    const p = recordFilePath(contractId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ExecutionRecoveryRecord;
  }

  function makeStore(): ExecutionRecoveryStore {
    return createExecutionRecoveryStore({ agentFs, audit });
  }

  function reopenController(store: ExecutionRecoveryStore): ExecutionRecoveryController {
    return createExecutionRecoveryController({
      store,
      audit,
      deliverResume: async (request) => { resumeCalls.push(request); return nextOutcome; },
      findPendingResume: async () => ({ kind: 'absent' }),
      inspectLlmRecoverySchedule: async () => undefined,
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
  }

  /**
   * 写前窗口故障注入：匹配 predicate 的首个 save 抛错（审计已写、状态未写），
   * 之后恢复——模拟「审计有、状态未前移」的崩溃窗口。
   */
  function makeCrashWindowStore(predicate: (record: ExecutionRecoveryRecord) => boolean): ExecutionRecoveryStore {
    const real = makeStore();
    let armed = true;
    return {
      load: real.load,
      save: (record) => {
        if (armed && predicate(record)) {
          armed = false;
          throw new Error('EIO save');
        }
        real.save(record);
      },
    };
  }

  function stalledSnapshot(overrides?: Partial<ExecutionActivitySnapshot>): ExecutionActivitySnapshot {
    return {
      activeContractId: CONTRACT_ID,
      lastActivityAt: BASE_NOW - TIMEOUT_MS - 1,
      turnInFlight: false,
      retryInFlight: false,
      asyncTaskInFlight: false,
      ...overrides,
    };
  }

  function rows(type: string) {
    return audit.entries.filter(e => e[0] === type);
  }

  function colOf(entry: [string, ...(string | number)[]], key: string): string | undefined {
    const hit = entry.find(c => String(c).startsWith(`${key}=`));
    return hit === undefined ? undefined : String(hit).slice(key.length + 1);
  }

  // ---------------------------------------------------------------------------
  // epoch reset（activity 前进）
  // ---------------------------------------------------------------------------

  it('epoch reset write-ahead：save 失败 → RESET 行已含 previous/next 全量、状态未前移；重启重推收敛', async () => {
    // 首次零计数 save（reset 分支）抛错；建 record attempts=1 的 save 通过
    const store = makeCrashWindowStore((r) => r.attempts === 0);
    const controller = reopenController(store);
    await controller.observe(stalledSnapshot());
    const beforeBytes = fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8');

    // activity 前进 → reset 分支：审计先行、save 抛错 → observe rejects
    await expect(controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW })))
      .rejects.toThrow('EIO save');

    const resetRows = rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET);
    expect(resetRows).toHaveLength(1);
    const reset = resetRows[0];
    expect(colOf(reset, 'reason')).toBe('activity_progressed');
    expect(JSON.parse(colOf(reset, 'previous_record')!).attempts).toBe(1);
    const intended = JSON.parse(colOf(reset, 'next_record')!);
    expect(intended).toMatchObject({ observedActivityAt: BASE_NOW, attempts: 0, lastAttemptAt: 0 });
    // 状态未前移（磁盘仍是旧 record 字节）
    expect(fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8')).toBe(beforeBytes);

    // 重启（健康 store）重推同变迁 → 收敛：磁盘 = 意图态；两行 next_record 一致
    const healthy = makeStore();
    const controller2 = reopenController(healthy);
    await controller2.observe(stalledSnapshot({ lastActivityAt: BASE_NOW }));
    expect(readRecordFile(CONTRACT_ID)).toMatchObject({ observedActivityAt: BASE_NOW, attempts: 0, lastAttemptAt: 0 });
    const resetRows2 = rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET);
    expect(resetRows2).toHaveLength(2);
    expect(JSON.parse(colOf(resetRows2[1], 'next_record')!)).toEqual(readRecordFile(CONTRACT_ID));
  });

  it('supersede 独立事件：pending 义务被 activity 前进 supersede → 独立行携带 delivery_id；无 pending 时不发', async () => {
    const store = makeStore();
    const controller = reopenController(store);
    nextOutcome = { kind: 'pending', stage: 'write', error: new Error('inbox down') };  // 义务保持 pending
    await controller.observe(stalledSnapshot());
    const deliveryId = readRecordFile(CONTRACT_ID)?.delivery?.id;
    expect(deliveryId).toBeDefined();
    expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('pending');

    await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW }));
    const supersededRows = rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_SUPERSEDED);
    expect(supersededRows).toHaveLength(1);
    expect(colOf(supersededRows[0], 'contract')).toBe(CONTRACT_ID);
    expect(colOf(supersededRows[0], 'delivery_id')).toBe(deliveryId);
    expect(colOf(supersededRows[0], 'reason')).toBe('activity_progressed');
    // reset 行 next_record 与磁盘一致（superseded 状态可重建）
    const resetRows = rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET);
    expect(JSON.parse(colOf(resetRows[0], 'next_record')!)).toEqual(readRecordFile(CONTRACT_ID));

    // 再前进一次（此时无 pending delivery）→ 不再发 superseded 行
    const countBefore = rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_SUPERSEDED).length;
    await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW + TIMEOUT_MS }));
    expect(rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_SUPERSEDED)).toHaveLength(countBefore);
  });

  // ---------------------------------------------------------------------------
  // 新登记（RESUME）
  // ---------------------------------------------------------------------------

  it('RESUME write-ahead：save 失败 → 意图行含未落盘 delivery_id；重启重登记（新 id）收敛、孤儿 id 无物理写', async () => {
    const store = makeCrashWindowStore((r) => r.attempts === 1);
    const controller = reopenController(store);
    await expect(controller.observe(stalledSnapshot())).rejects.toThrow('EIO save');

    const resumeRows = rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME);
    expect(resumeRows).toHaveLength(1);
    const orphanId = colOf(resumeRows[0], 'delivery_id');
    expect(orphanId).toBeDefined();
    expect(JSON.parse(colOf(resumeRows[0], 'next_record')!).delivery.id).toBe(orphanId);
    // 状态未前移：无 record 文件、无投递调用
    expect(readRecordFile(CONTRACT_ID)).toBeNull();
    expect(resumeCalls).toHaveLength(0);

    // 重启重登记：新 delivery_id（≠ 孤儿），收敛
    const healthy = makeStore();
    const controller2 = reopenController(healthy);
    await controller2.observe(stalledSnapshot());
    expect(resumeCalls).toHaveLength(1);
    const committedId = resumeCalls[0].delivery.id;
    expect(committedId).not.toBe(orphanId);
    expect(readRecordFile(CONTRACT_ID)?.delivery?.id).toBe(committedId);
    const resumeRows2 = rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME);
    expect(resumeRows2).toHaveLength(2);
    // RESUME 行 next_record = 该变迁时刻目标态（pending 义务）；确认是后续独立变迁
    const committedIntended = JSON.parse(colOf(resumeRows2[1], 'next_record')!);
    expect(committedIntended).toMatchObject({ attempts: 1 });
    expect(committedIntended.delivery).toMatchObject({ kind: 'pending', id: committedId });
  });

  // ---------------------------------------------------------------------------
  // 交付确认（confirmed）
  // ---------------------------------------------------------------------------

  it('确认 write-ahead：confirm save 失败 → 确认意图行含 next_record、状态仍 pending；重启再确认收敛（同 id）', async () => {
    const real = makeStore();
    const store: ExecutionRecoveryStore = {
      load: real.load,
      save: (record) => {
        if (record.delivery?.kind === 'confirmed') throw new Error('EIO confirm save');
        real.save(record);
      },
    };
    const controller = reopenController(store);
    await expect(controller.observe(stalledSnapshot())).rejects.toThrow('EIO confirm save');

    const confirmRows = audit.entries.filter(e =>
      e.some(col => String(col) === 'context=executionRecoveryDeliveryConfirmed'));
    expect(confirmRows).toHaveLength(1);
    const nextRecord = JSON.parse(colOf(confirmRows[0], 'next_record')!);
    expect(nextRecord.delivery.kind).toBe('confirmed');
    const deliveryId = nextRecord.delivery.id;
    // 状态未前移：磁盘仍 pending（同一 id）
    expect(readRecordFile(CONTRACT_ID)?.delivery).toMatchObject({ kind: 'pending', id: deliveryId });

    // 重启（健康 store）→ 再确认同一 id 收敛
    const healthy = makeStore();
    const controller2 = reopenController(healthy);
    await controller2.observe(stalledSnapshot());
    expect(readRecordFile(CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: deliveryId });
    const confirmRows2 = audit.entries.filter(e =>
      e.some(col => String(col) === 'context=executionRecoveryDeliveryConfirmed'));
    expect(confirmRows2).toHaveLength(2);
    expect(JSON.parse(colOf(confirmRows2[1], 'next_record')!)).toEqual(readRecordFile(CONTRACT_ID));
  });

  // ---------------------------------------------------------------------------
  // 正常路径可重建性（三变迁）
  // ---------------------------------------------------------------------------

  it('正常路径：每行 next_record = 该变迁时刻目标态；末变迁行与磁盘 record 逐字一致', async () => {
    const store = makeStore();
    const controller = reopenController(store);
    await controller.observe(stalledSnapshot());

    // RESUME 行：登记时刻目标态（pending 义务、attempts=1）
    const resumeRow = rows(EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME)[0];
    const resumeIntended = JSON.parse(colOf(resumeRow, 'next_record')!);
    expect(resumeIntended).toMatchObject({ attempts: 1, lastAttemptAt: BASE_NOW });
    expect(resumeIntended.delivery).toMatchObject({ kind: 'pending', attempt: 1, scheduledAt: BASE_NOW });

    // confirmed 行：末次变迁，next_record 与磁盘 record 逐字一致（状态级可重建）
    const confirmRow = audit.entries.find(e =>
      e.some(col => String(col) === 'context=executionRecoveryDeliveryConfirmed'))!;
    expect(JSON.parse(colOf(confirmRow, 'next_record')!)).toEqual(readRecordFile(CONTRACT_ID));
  });
});
