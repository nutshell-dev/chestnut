/**
 * Phase 1396 Step E: EventLoop-owned execution stall recovery — unit tests.
 *
 * 覆盖 execution-recovery controller/store 语义：
 * - in-flight（turn / retry / async task）不打扰
 * - 无 active contract / 未超时不动作；contract 消失清理 record
 * - activity 前进 reset、同窗口重入幂等、重启从 record 恢复
 * - 前 MAX 次 self-resume、耗尽 single failure、sink 失败保留 record 重试交付
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  createExecutionRecoveryStore,
  createExecutionRecoveryController,
  MAX_EXECUTION_RECOVERY_ATTEMPTS,
  type ExecutionRecoveryController,
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

describe('execution-recovery controller', () => {
  let rootDir: string;
  let rootFs: NodeFileSystem;
  let audit: ReturnType<typeof createMockAudit>;
  let currentNow: number;
  let resumeCalls: ExecutionRecoveryRecord[];
  let sinkReport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    rootDir = path.join(os.tmpdir(), `execution-recovery-test-${randomUUID()}`);
    fs.mkdirSync(rootDir, { recursive: true });
    rootFs = new NodeFileSystem({ baseDir: rootDir });
    audit = createMockAudit();
    currentNow = BASE_NOW;
    resumeCalls = [];
    sinkReport = vi.fn().mockResolvedValue([]);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function recordFilePath(contractId: string): string {
    return path.join(rootDir, EXECUTION_RECOVERY_DIR, `${contractId}.json`);
  }

  function readRecordFile(contractId: string): ExecutionRecoveryRecord | null {
    const p = recordFilePath(contractId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ExecutionRecoveryRecord;
  }

  function makeController(): { store: ExecutionRecoveryStore; controller: ExecutionRecoveryController } {
    const store = createExecutionRecoveryStore({ rootFs, audit });
    const controller = createExecutionRecoveryController({
      store,
      failureSink: { report: sinkReport },
      audit,
      enqueueResume: (record) => { resumeCalls.push(record); },
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
    return { store, controller };
  }

  /** 已超时（lastActivityAt 早于 now - timeoutMs）的停滞 snapshot。 */
  function stalledSnapshot(overrides?: Partial<ExecutionActivitySnapshot>): ExecutionActivitySnapshot {
    return {
      executorId: 'claw-1',
      activeContractId: CONTRACT_ID,
      lastActivityAt: BASE_NOW - TIMEOUT_MS - 1,
      turnInFlight: false,
      retryInFlight: false,
      asyncTaskInFlight: false,
      ...overrides,
    };
  }

  describe('in-flight 不打扰', () => {
    it('turn 在途：不建 record、不 resume、不 report', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ turnInFlight: true }));
      expect(resumeCalls).toHaveLength(0);
      expect(sinkReport).not.toHaveBeenCalled();
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });

    it('retry 在途：不建 record、不 resume、不 report', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ retryInFlight: true }));
      expect(resumeCalls).toHaveLength(0);
      expect(sinkReport).not.toHaveBeenCalled();
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });

    it('async task 在途：不判 stall（反向验收）', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ asyncTaskInFlight: true }));
      expect(resumeCalls).toHaveLength(0);
      expect(sinkReport).not.toHaveBeenCalled();
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });
  });

  describe('无 contract / 未超时', () => {
    it('无 active contract：不动作', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ activeContractId: undefined }));
      expect(resumeCalls).toHaveLength(0);
      expect(sinkReport).not.toHaveBeenCalled();
    });

    it('无 active contract 且磁盘有残留 record：删除 record', async () => {
      const { store, controller } = makeController();
      store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - 10 * TIMEOUT_MS,
        attempts: 2,
        lastAttemptAt: BASE_NOW - 5 * TIMEOUT_MS,
      });
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(true);
      await controller.observe(stalledSnapshot({ activeContractId: undefined }));
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      expect(sinkReport).not.toHaveBeenCalled();
    });

    it('未超时：不建 record、不 resume', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW - TIMEOUT_MS + 1 }));
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });
  });

  describe('reset / dedupe / restart', () => {
    it('activity 前进：删除旧 record 并 audit reset（恢复消息自身不算 progress 由 probe 语义保证）', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot());
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);

      // activity 前进到 now（turn 真的跑了）→ record 复位
      await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW }));
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET)).toBe(true);
    });

    it('相同窗口重入幂等：同 tick 重复 observe 只 +1 attempt、只 enqueue 一次', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot());
      await controller.observe(stalledSnapshot());
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
    });

    it('每满一个新超时窗口才允许下一次 attempt', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot());
      currentNow += TIMEOUT_MS - 1;
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      currentNow += 1;
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(2);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(2);
    });

    it('进程重启：从磁盘 record 恢复 attempt 计数', async () => {
      const { store } = makeController();
      store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - TIMEOUT_MS - 1,
        attempts: 2,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      });
      // 新 controller（模拟重启后重建）读同一 store
      const controller = createExecutionRecoveryController({
        store: createExecutionRecoveryStore({ rootFs, audit }),
        failureSink: { report: sinkReport },
        audit,
        enqueueResume: (record) => { resumeCalls.push(record); },
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0].attempts).toBe(3);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(3);
    });

    it('contract 切换：清理旧 contract 的残留 record', async () => {
      const { store, controller } = makeController();
      store.save({
        schema_version: 1,
        contractId: 'old-contract',
        observedActivityAt: BASE_NOW - 10 * TIMEOUT_MS,
        attempts: 1,
        lastAttemptAt: BASE_NOW - 5 * TIMEOUT_MS,
      });
      await controller.observe(stalledSnapshot({ activeContractId: 'new-contract' }));
      expect(fs.existsSync(recordFilePath('old-contract'))).toBe(false);
      expect(readRecordFile('new-contract')?.attempts).toBe(1);
    });
  });

  describe('self-resume 与耗尽交付', () => {
    it('首次超时：先落盘 attempt=1 record，再向自身 enqueue 高优 resume', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0]).toMatchObject({ contractId: CONTRACT_ID, attempts: 1 });
      const persisted = readRecordFile(CONTRACT_ID);
      expect(persisted).toMatchObject({ schema_version: 1, contractId: CONTRACT_ID, attempts: 1 });
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME)).toBe(true);
      expect(sinkReport).not.toHaveBeenCalled();
    });

    it('前 MAX 次均 self-resume；耗尽后 single failure（record 即 terminal evidence，先持久化再 report）', async () => {
      sinkReport.mockImplementation(async () => {
        // report 时 evidence 必须已持久化且 attempts 已耗尽
        const evidence = readRecordFile(CONTRACT_ID);
        expect(evidence?.attempts).toBe(MAX_EXECUTION_RECOVERY_ATTEMPTS);
        return [{ kind: 'committed' }];
      });
      const { controller } = makeController();
      for (let i = 1; i <= MAX_EXECUTION_RECOVERY_ATTEMPTS; i++) {
        await controller.observe(stalledSnapshot());
        expect(resumeCalls).toHaveLength(i);
        expect(sinkReport).not.toHaveBeenCalled();
        currentNow += TIMEOUT_MS;
      }
      // 第 MAX+1 个超时窗口：attempts 耗尽 → 交付 failure
      await controller.observe(stalledSnapshot());
      expect(sinkReport).toHaveBeenCalledTimes(1);
      expect(sinkReport).toHaveBeenCalledWith({
        executorId: 'claw-1',
        producer: 'runtime',
        reason: 'agent_spontaneous_stall',
        evidenceRef: `${EXECUTION_RECOVERY_DIR}/${CONTRACT_ID}.json`,
      });
      // 交付成功 → record 删除；不重复恢复
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_FAILURE_DELIVERED)).toBe(true);
      // contract 已 terminal（不再 active）→ 后续 observe 不重复 report
      await controller.observe(stalledSnapshot({ activeContractId: undefined }));
      expect(sinkReport).toHaveBeenCalledTimes(1);
    });

    it('sink 抛错：保留 record、不重复恢复，下 tick 重试交付（反向验收：evidence 不丢、计数不重置）', async () => {
      const { controller } = makeController();
      for (let i = 0; i < MAX_EXECUTION_RECOVERY_ATTEMPTS; i++) {
        await controller.observe(stalledSnapshot());
        currentNow += TIMEOUT_MS;
      }
      sinkReport.mockRejectedValueOnce(new Error('contract fs down'));
      await controller.observe(stalledSnapshot());
      expect(sinkReport).toHaveBeenCalledTimes(1);
      // record 保留、attempts 不重置、不再 enqueue resume
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(MAX_EXECUTION_RECOVERY_ATTEMPTS);
      expect(resumeCalls).toHaveLength(MAX_EXECUTION_RECOVERY_ATTEMPTS);
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_FAILED)).toBe(true);
      // 下一窗口重试交付成功 → record 删除
      currentNow += TIMEOUT_MS;
      await controller.observe(stalledSnapshot());
      expect(sinkReport).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });

    it('sink 返回 retryable_failure outcome：视为未交付，保留 record 下 tick 重试', async () => {
      const { controller } = makeController();
      for (let i = 0; i < MAX_EXECUTION_RECOVERY_ATTEMPTS; i++) {
        await controller.observe(stalledSnapshot());
        currentNow += TIMEOUT_MS;
      }
      sinkReport.mockResolvedValueOnce([{ kind: 'retryable_failure' }]);
      await controller.observe(stalledSnapshot());
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(MAX_EXECUTION_RECOVERY_ATTEMPTS);
      currentNow += TIMEOUT_MS;
      await controller.observe(stalledSnapshot());
      expect(sinkReport).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });
  });

  describe('store', () => {
    it('save/load/delete roundtrip', () => {
      const { store } = makeController();
      const record: ExecutionRecoveryRecord = {
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: 123,
        attempts: 2,
        lastAttemptAt: 456,
      };
      store.save(record);
      expect(store.load(CONTRACT_ID)).toEqual(record);
      store.delete(CONTRACT_ID);
      expect(store.load(CONTRACT_ID)).toBeNull();
    });

    it('recordRef 为 chestnut-root 相对路径（evidenceRef 语义）', () => {
      const { store } = makeController();
      expect(store.recordRef(CONTRACT_ID)).toBe(`${EXECUTION_RECOVERY_DIR}/${CONTRACT_ID}.json`);
    });

    it('损坏 record：load 返回 null 并 audit（不抛）', () => {
      const { store } = makeController();
      fs.mkdirSync(path.join(rootDir, EXECUTION_RECOVERY_DIR), { recursive: true });
      fs.writeFileSync(recordFilePath(CONTRACT_ID), 'not-json{{{');
      expect(store.load(CONTRACT_ID)).toBeNull();
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL)).toBe(true);
    });
  });
});
