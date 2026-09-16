/**
 * Phase 1396 Step E: EventLoop-owned execution stall recovery — unit tests.
 * Phase 1840: 提醒不再升级为契约失败——持续提醒语义替换旧耗尽/失败交付约束。
 *
 * 覆盖 execution-recovery controller/store 语义：
 * - in-flight（turn / retry / async task）不打扰
 * - 无 active contract / 未超时不动作；contract 消失清理 record
 * - activity 前进 reset、同窗口重入幂等、重启从 record 恢复
 * - 持续 self-resume（无次数上限）、旧 attempts>=3 record 到期继续计数
 * - store.save / enqueue 失败的保留语义；真实 Messaging 读回投递
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
  type ExecutionRecoveryStore,
  type ExecutionActivitySnapshot,
  type ExecutionRecoveryRecord,
} from '../../../src/core/event-loop/execution-recovery.js';
import { EXECUTION_RECOVERY_DIR } from '../../../src/core/event-loop/constants.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createInboxReader, notifyInbox } from '../../../src/foundation/messaging/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

const TIMEOUT_MS = 1000;
const BASE_NOW = 1_700_000_000_000;
const CONTRACT_ID = '1700000000000-abcd';

const FAILURE_DELIVERY_AUDITS: readonly string[] = [
  EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_FAILURE_DELIVERED,
  EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_FAILED,
  EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_REJECTED,
];

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

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    rootDir = path.join(os.tmpdir(), `execution-recovery-test-${randomUUID()}`);
    fs.mkdirSync(rootDir, { recursive: true });
    rootFs = new NodeFileSystem({ baseDir: rootDir });
    audit = createMockAudit();
    currentNow = BASE_NOW;
    resumeCalls = [];
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
      audit,
      enqueueResume: (record) => { resumeCalls.push(record); },
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
    return { store, controller };
  }

  /** 用同一 store 重建 controller（模拟重启 / 升级后新进程）。 */
  function reopenController(store: ExecutionRecoveryStore): ExecutionRecoveryController {
    return createExecutionRecoveryController({
      store,
      audit,
      enqueueResume: (record) => { resumeCalls.push(record); },
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
  }

  /** 已超时（lastActivityAt 早于 now - timeoutMs）的停滞 snapshot。 */
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

  function expectNoFailureDeliveryAudit(): void {
    expect(audit.entries.some(e => FAILURE_DELIVERY_AUDITS.includes(e[0]))).toBe(false);
  }

  describe('in-flight 不打扰', () => {
    it('turn 在途：不建 record、不 resume', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ turnInFlight: true }));
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });

    it('retry 在途：不建 record、不 resume', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ retryInFlight: true }));
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });

    it('async task 在途：不判 stall（反向验收）', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ asyncTaskInFlight: true }));
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });

    it('已有 attempts=3 record 时 turn 在途：record 与 enqueue 不变', async () => {
      const { store, controller } = makeController();
      const existing: ExecutionRecoveryRecord = {
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - TIMEOUT_MS - 1,
        attempts: 3,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      };
      store.save(existing);
      await controller.observe(stalledSnapshot({ turnInFlight: true }));
      expect(readRecordFile(CONTRACT_ID)).toEqual(existing);
      expect(resumeCalls).toHaveLength(0);
    });

    it('已有 attempts=3 record 时 retry 在途：record 与 enqueue 不变', async () => {
      const { store, controller } = makeController();
      const existing: ExecutionRecoveryRecord = {
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - TIMEOUT_MS - 1,
        attempts: 3,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      };
      store.save(existing);
      await controller.observe(stalledSnapshot({ retryInFlight: true }));
      expect(readRecordFile(CONTRACT_ID)).toEqual(existing);
      expect(resumeCalls).toHaveLength(0);
    });

    it('已有 attempts=3 record 时 async task 在途：record 与 enqueue 不变', async () => {
      const { store, controller } = makeController();
      const existing: ExecutionRecoveryRecord = {
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - TIMEOUT_MS - 1,
        attempts: 3,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      };
      store.save(existing);
      await controller.observe(stalledSnapshot({ asyncTaskInFlight: true }));
      expect(readRecordFile(CONTRACT_ID)).toEqual(existing);
      expect(resumeCalls).toHaveLength(0);
    });
  });

  describe('无 contract / 未超时', () => {
    it('无 active contract：不动作', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ activeContractId: undefined }));
      expect(resumeCalls).toHaveLength(0);
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
      const controller = reopenController(createExecutionRecoveryStore({ rootFs, audit }));
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

  describe('持续提醒（Phase 1840：无次数上限、无失败出口）', () => {
    it('首次超时：先落盘 attempt=1 record，再向自身 enqueue 高优 resume', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0]).toMatchObject({ contractId: CONTRACT_ID, attempts: 1 });
      const persisted = readRecordFile(CONTRACT_ID);
      expect(persisted).toMatchObject({ schema_version: 1, contractId: CONTRACT_ID, attempts: 1 });
      const resumeAudit = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME);
      expect(resumeAudit).toBeDefined();
      expect(resumeAudit!.some(col => String(col) === `interval_ms=${TIMEOUT_MS}`)).toBe(true);
      expectNoFailureDeliveryAudit();
    });

    it('连续 6 个到期窗口：attempt=1..6 各 enqueue 一次，record 持续存在，同窗口不重复，全程无失败交付 audit', async () => {
      const { controller } = makeController();
      for (let i = 1; i <= 6; i++) {
        await controller.observe(stalledSnapshot());
        expect(resumeCalls).toHaveLength(i);
        expect(resumeCalls[i - 1].attempts).toBe(i);
        expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(i);
        // 同窗口重入不增加
        await controller.observe(stalledSnapshot());
        expect(resumeCalls).toHaveLength(i);
        expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(i);
        currentNow += TIMEOUT_MS;
      }
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(true);
      expectNoFailureDeliveryAudit();
    });

    it('旧 attempts=3 schema1 record（升级后重建 controller）：到期前无动作，到期后 attempt=4 继续提醒', async () => {
      const { store } = makeController();
      const lastActivityAt = BASE_NOW - TIMEOUT_MS - 1;
      store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: lastActivityAt,
        attempts: 3,
        lastAttemptAt: BASE_NOW - TIMEOUT_MS / 2,
      });
      const controller = reopenController(createExecutionRecoveryStore({ rootFs, audit }));
      // 窗口未到期：不动作（不删 record、不重置）
      await controller.observe(stalledSnapshot({ lastActivityAt }));
      expect(resumeCalls).toHaveLength(0);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(3);
      // 到期：attempt+1，observedActivityAt 保持（不伪造新 epoch）
      currentNow += TIMEOUT_MS / 2;
      await controller.observe(stalledSnapshot({ lastActivityAt }));
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0].attempts).toBe(4);
      const persisted = readRecordFile(CONTRACT_ID)!;
      expect(persisted.attempts).toBe(4);
      expect(persisted.observedActivityAt).toBe(lastActivityAt);
      expectNoFailureDeliveryAudit();
    });

    it('旧 attempts=7（高于旧阈值）record：到期后 attempt=8 继续提醒', async () => {
      const { store } = makeController();
      const lastActivityAt = BASE_NOW - TIMEOUT_MS - 1;
      store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: lastActivityAt,
        attempts: 7,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      });
      const controller = reopenController(createExecutionRecoveryStore({ rootFs, audit }));
      await controller.observe(stalledSnapshot({ lastActivityAt }));
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0].attempts).toBe(8);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(8);
      expectNoFailureDeliveryAudit();
    });

    it('store.save 抛错：不 enqueue、错误沿现有传播；恢复后可再次 observe 正常登记', async () => {
      const realStore = createExecutionRecoveryStore({ rootFs, audit });
      let failSave = true;
      const store: ExecutionRecoveryStore = {
        ...realStore,
        save: (record) => {
          if (failSave) {
            failSave = false;
            throw new Error('EIO save');
          }
          realStore.save(record);
        },
      };
      const controller = reopenController(store);
      await expect(controller.observe(stalledSnapshot())).rejects.toThrow('EIO save');
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      // 上次 attempt 未落盘 → 恢复后同窗口可再次登记
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
    });

    it('enqueue 抛错：record 已持久化；同窗口不重发，下一窗口继续（不偷换为投递确认）', async () => {
      let failEnqueue = true;
      const controller = createExecutionRecoveryController({
        store: createExecutionRecoveryStore({ rootFs, audit }),
        audit,
        enqueueResume: (record) => {
          if (failEnqueue) {
            failEnqueue = false;
            throw new Error('inbox down');
          }
          resumeCalls.push(record);
        },
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      await expect(controller.observe(stalledSnapshot())).rejects.toThrow('inbox down');
      // 调度尝试已登记落盘（attempt 是调度计数，不是成功通知数）
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
      expect(resumeCalls).toHaveLength(0);
      // 同窗口不补发
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(0);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
      // 下一窗口继续
      currentNow += TIMEOUT_MS;
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0].attempts).toBe(2);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(2);
    });
  });

  describe('真实 Messaging 投递读回', () => {
    it('controller 真实 store + enqueue 回调调现有 notifyInbox：4 个到期窗口写入 4 条 execution_recovery，drainAndDeliver 读回并真实 ack', async () => {
      const agentDir = path.join(rootDir, 'claws', 'claw-1');
      const pendingDir = path.join(agentDir, 'inbox', 'pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const agentFs = new NodeFileSystem({ baseDir: agentDir });
      const controller = createExecutionRecoveryController({
        store: createExecutionRecoveryStore({ rootFs, audit }),
        audit,
        enqueueResume: (record) => {
          // 只为验证调度链路的简单 body（不复制模板实现）；投递语义同生产
          // notifyInbox（best-effort 自吞错，不是投递确认）。
          notifyInbox(agentFs, {
            inboxDir: pendingDir,
            type: 'execution_recovery',
            source: 'claw-1',
            priority: 'high',
            body: `resume attempt ${record.attempts}`,
            metadata: { contract_id: record.contractId },
          }, audit);
        },
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      for (let i = 1; i <= 4; i++) {
        await controller.observe(stalledSnapshot());
        currentNow += TIMEOUT_MS;
      }

      const reader = createInboxReader(agentFs, audit, 'inbox');
      const batch = await reader.drainAndDeliver();
      expect(batch.kind).toBe('complete');
      if (batch.kind !== 'complete') return;
      expect(batch.entries).toHaveLength(4);
      for (const entry of batch.entries) {
        expect(entry.message.type).toBe('execution_recovery');
        expect(entry.message.from).toBe('claw-1');
        expect(entry.message.metadata?.contract_id).toBe(CONTRACT_ID);
      }
      for (const handle of batch.handles) {
        await reader.ack(handle);
      }
      expect(fs.readdirSync(path.join(agentDir, 'inbox', 'done'))).toHaveLength(4);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(4);
      expectNoFailureDeliveryAudit();
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

    it('损坏 record：load 返回 null 并 audit（不抛）', () => {
      const { store } = makeController();
      fs.mkdirSync(path.join(rootDir, EXECUTION_RECOVERY_DIR), { recursive: true });
      fs.writeFileSync(recordFilePath(CONTRACT_ID), 'not-json{{{');
      expect(store.load(CONTRACT_ID)).toBeNull();
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL)).toBe(true);
    });
  });
});
