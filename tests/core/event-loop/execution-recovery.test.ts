/**
 * Phase 1396 Step E: EventLoop-owned execution stall recovery — unit tests.
 * Phase 1840: 提醒不再升级为契约失败——持续提醒语义替换旧耗尽/失败交付约束。
 * Phase 1841: 记录按实例归属——local（agentDir）优先、旧 root 共享目录只读继承；
 * 无 active / 契约切换不再删除任何记录；activity 前进保存零计数记录而非删除。
 * Phase 1842: 一次提醒的交付义务——pending 先落盘（冻结 id/正文），owner 证实
 * 消息存在才 confirmed；未确认跨 observe/重启以同一身份补投，不额外计次。
 * Phase 1843: 新登记前查 owner pending——已有本 claw 同契约执行提醒或查询未知
 * 均不登记新义务（absent 默认值是本模块模拟依赖，真实 owner 能力见
 * execution-recovery-delivery.test.ts 真实链）。
 *
 * 覆盖 execution-recovery controller/store 语义：
 * - in-flight（turn / retry / async task）不打扰
 * - 无 active contract / 未超时不动作；未选中记录原样保留
 * - activity 前进保存零计数 record（audit reset 带前记录）、同窗口重入幂等、
 *   重启从 record 恢复
 * - 持续 self-resume（无次数上限）、旧 attempts>=3 record 到期继续计数
 * - store.save 失败的保留语义；交付 pending/confirmed 状态机与冷却
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
  type PendingExecutionResume,
} from '../../../src/core/event-loop/execution-recovery.js';
import { EXECUTION_RECOVERY_DIR } from '../../../src/core/event-loop/constants.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { LLMRecoverySchedule } from '../../../src/foundation/llm-orchestrator/index.js';

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
  let agentDir: string;
  let rootFs: NodeFileSystem;
  let agentFs: NodeFileSystem;
  let audit: ReturnType<typeof createMockAudit>;
  let currentNow: number;
  let resumeCalls: ExecutionRecoveryDeliveryRequest[];
  /** 默认投递结果：confirmed（另可局部替换为 pending/throw）。 */
  let nextOutcome: ExecutionRecoveryDeliveryOutcome;
  /** Phase 1843: 可控 pending 查询 stub（默认 absent）及调用记录。 */
  let nextPendingResume: PendingExecutionResume;
  let pendingResumeCalls: string[];
  let pendingResumeError: Error | null;
  /** Phase 1844: 可控 LLM 安排查询 stub（默认 undefined=装配未注入 owner）及调用记录。 */
  let nextSchedule: LLMRecoverySchedule | undefined;
  let scheduleInspectCalls: number;
  let scheduleInspectError: Error | null;

  /** 显式查询依赖：抛错经 rejection 保留原异常，不折 absent。 */
  function findPendingResume(contractId: string): Promise<PendingExecutionResume> {
    pendingResumeCalls.push(contractId);
    if (pendingResumeError) return Promise.reject(pendingResumeError);
    return Promise.resolve(nextPendingResume);
  }

  /** 显式安排查询依赖：undefined 只表示未注入 owner；抛错经 rejection 保留原异常。 */
  function inspectLlmRecoverySchedule(): Promise<LLMRecoverySchedule | undefined> {
    scheduleInspectCalls += 1;
    if (scheduleInspectError) return Promise.reject(scheduleInspectError);
    return Promise.resolve(nextSchedule);
  }

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    rootDir = path.join(os.tmpdir(), `execution-recovery-test-${randomUUID()}`);
    // agentDir 形如 <root>/claws/<clawId>：local record 落 agentDir，legacy 只读 rootDir。
    agentDir = path.join(rootDir, 'claws', 'claw-1');
    fs.mkdirSync(agentDir, { recursive: true });
    rootFs = new NodeFileSystem({ baseDir: rootDir });
    agentFs = new NodeFileSystem({ baseDir: agentDir });
    audit = createMockAudit();
    currentNow = BASE_NOW;
    resumeCalls = [];
    nextOutcome = { kind: 'confirmed' };
    nextPendingResume = { kind: 'absent' };
    pendingResumeCalls = [];
    pendingResumeError = null;
    nextSchedule = undefined;
    scheduleInspectCalls = 0;
    scheduleInspectError = null;
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  /** Phase 1841: 本地记录路径（<agentDir>/event-loop/execution-recovery/）。 */
  function recordFilePath(contractId: string): string {
    return path.join(agentDir, EXECUTION_RECOVERY_DIR, `${contractId}.json`);
  }

  /** 旧 root 共享目录路径（只读基线来源）。 */
  function legacyRecordFilePath(contractId: string): string {
    return path.join(rootDir, EXECUTION_RECOVERY_DIR, `${contractId}.json`);
  }

  function readRecordFile(contractId: string): ExecutionRecoveryRecord | null {
    const p = recordFilePath(contractId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ExecutionRecoveryRecord;
  }

  function makeStore(): ExecutionRecoveryStore {
    return createExecutionRecoveryStore({ agentFs, legacyRootFs: rootFs, audit });
  }

  function makeController(): { store: ExecutionRecoveryStore; controller: ExecutionRecoveryController } {
    const store = makeStore();
    const controller = createExecutionRecoveryController({
      store,
      audit,
      deliverResume: async (request) => { resumeCalls.push(request); return nextOutcome; },
      findPendingResume,
      inspectLlmRecoverySchedule,
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
    return { store, controller };
  }

  /** 用新 store 重建 controller（模拟重启 / 升级后新进程）。 */
  function reopenController(store: ExecutionRecoveryStore): ExecutionRecoveryController {
    return createExecutionRecoveryController({
      store,
      audit,
      deliverResume: async (request) => { resumeCalls.push(request); return nextOutcome; },
      findPendingResume,
      inspectLlmRecoverySchedule,
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

    it('无 active contract 且磁盘有残留 record：record 原字节保留（Phase 1841：未选中不授权删除）', async () => {
      const { store, controller } = makeController();
      const existing: ExecutionRecoveryRecord = {
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - 10 * TIMEOUT_MS,
        attempts: 2,
        lastAttemptAt: BASE_NOW - 5 * TIMEOUT_MS,
      };
      store.save(existing);
      const bytesBefore = fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8');
      await controller.observe(stalledSnapshot({ activeContractId: undefined }));
      expect(fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8')).toBe(bytesBefore);
      expect(readRecordFile(CONTRACT_ID)).toEqual(existing);
      expect(resumeCalls).toHaveLength(0);
      // 无 active / 切换不产生虚假 reset 审计
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET)).toBe(false);
    });

    it('未超时：不建 record、不 resume', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW - TIMEOUT_MS + 1 }));
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    });
  });

  describe('reset / dedupe / restart', () => {
    it('activity 前进：保存零计数 record 并 audit reset（保留已建立本地状态与来源证据；恢复消息自身不算 progress 由 probe 语义保证）', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot());
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
      const resetAuditCountBefore = audit.entries.filter(
        e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET,
      ).length;

      // activity 前进到 now（turn 真的跑了）→ 零计数 record 持久化（不删除）
      await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW }));
      const persisted = readRecordFile(CONTRACT_ID);
      expect(persisted).toMatchObject({
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW,
        attempts: 0,
        lastAttemptAt: 0,
      });
      const resetAudits = audit.entries.filter(
        e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET,
      );
      expect(resetAudits.length).toBe(resetAuditCountBefore + 1);
      const resetAudit = resetAudits[resetAudits.length - 1];
      expect(resetAudit.some(col => String(col) === 'reason=activity_progressed')).toBe(true);
      // RESET 审计附前记录原文（含重置前 attempts=1）
      const previousCol = resetAudit.find(col => String(col).startsWith('previous_record='));
      expect(previousCol).toBeDefined();
      expect(JSON.parse(String(previousCol).slice('previous_record='.length)).attempts).toBe(1);
      // 活动未超时：reset 后本 tick 不产生新 epoch 提醒
      expect(resumeCalls).toHaveLength(1);
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
      const controller = reopenController(makeStore());
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0].delivery.attempt).toBe(3);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(3);
    });

    it('contract 切换：旧 contract record 原字节保留，下次选中继续其计数（Phase 1841）', async () => {
      const { store, controller } = makeController();
      const oldRecord: ExecutionRecoveryRecord = {
        schema_version: 1,
        contractId: 'old-contract',
        observedActivityAt: BASE_NOW - 10 * TIMEOUT_MS,
        attempts: 1,
        lastAttemptAt: BASE_NOW - 5 * TIMEOUT_MS,
      };
      store.save(oldRecord);
      const oldBytesBefore = fs.readFileSync(recordFilePath('old-contract'), 'utf8');
      // 选中 new-contract（停滞）→ 只写新记录，旧记录不受影响
      await controller.observe(stalledSnapshot({ activeContractId: 'new-contract' }));
      expect(fs.readFileSync(recordFilePath('old-contract'), 'utf8')).toBe(oldBytesBefore);
      expect(readRecordFile('new-contract')?.attempts).toBe(1);
      // 不产生虚假 reset 审计
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET)).toBe(false);
      // 下次再选中旧 contract（窗口早已到期、activity 未前进）→ 继续旧计数
      await controller.observe(stalledSnapshot({
        activeContractId: 'old-contract',
        lastActivityAt: oldRecord.observedActivityAt,
      }));
      expect(readRecordFile('old-contract')?.attempts).toBe(2);
      expect(resumeCalls[resumeCalls.length - 1].contractId).toBe('old-contract');
    });
  });

  describe('持续提醒（Phase 1840：无次数上限、无失败出口；Phase 1842：交付义务状态机）', () => {
    it('首次超时：先落盘 attempt=1 pending 义务，交付确认后 confirmed（同一冻结 id/body）', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0].contractId).toBe(CONTRACT_ID);
      expect(resumeCalls[0].delivery.attempt).toBe(1);
      const persisted = readRecordFile(CONTRACT_ID);
      expect(persisted).toMatchObject({ schema_version: 1, contractId: CONTRACT_ID, attempts: 1 });
      // 交付确认后落 confirmed；id/body/scheduledAt 与请求一致（冻结字段不变）
      expect(persisted?.delivery).toMatchObject({
        kind: 'confirmed',
        id: resumeCalls[0].delivery.id,
        attempt: 1,
        scheduledAt: BASE_NOW,
        body: resumeCalls[0].delivery.body,
        confirmedAt: BASE_NOW,
      });
      const resumeAudit = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME);
      expect(resumeAudit).toBeDefined();
      expect(resumeAudit!.some(col => String(col) === `interval_ms=${TIMEOUT_MS}`)).toBe(true);
      expect(resumeAudit!.some(col => String(col) === `delivery_id=${resumeCalls[0].delivery.id}`)).toBe(true);
      expect(resumeAudit!.some(col => String(col) === 'delivery_state=pending')).toBe(true);
      const confirmedAudit = audit.entries.find(e =>
        e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION &&
        e.some(col => String(col) === 'context=executionRecoveryDeliveryConfirmed'));
      expect(confirmedAudit).toBeDefined();
      expect(confirmedAudit!.some(col => String(col) === `delivery_id=${resumeCalls[0].delivery.id}`)).toBe(true);
      expectNoFailureDeliveryAudit();
    });

    it('连续 6 个到期窗口：attempt=1..6 各交付一次（确认后下一窗口自 confirmedAt 起算），record 持续存在，同窗口不重复，全程无失败交付 audit', async () => {
      const { controller } = makeController();
      for (let i = 1; i <= 6; i++) {
        await controller.observe(stalledSnapshot());
        expect(resumeCalls).toHaveLength(i);
        expect(resumeCalls[i - 1].delivery.attempt).toBe(i);
        expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(i);
        // 同窗口重入不增加
        await controller.observe(stalledSnapshot());
        expect(resumeCalls).toHaveLength(i);
        expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(i);
        currentNow += TIMEOUT_MS;
      }
      // 每次确认各有不同的冻结 id（同 attempt 序号递增），不复用上一义务身份
      const ids = resumeCalls.map(r => r.delivery.id);
      expect(new Set(ids).size).toBe(6);
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
      const controller = reopenController(makeStore());
      // 窗口未到期：不动作（不删 record、不重置）
      await controller.observe(stalledSnapshot({ lastActivityAt }));
      expect(resumeCalls).toHaveLength(0);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(3);
      // 到期：attempt+1，observedActivityAt 保持（不伪造新 epoch）
      currentNow += TIMEOUT_MS / 2;
      await controller.observe(stalledSnapshot({ lastActivityAt }));
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0].delivery.attempt).toBe(4);
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
      const controller = reopenController(makeStore());
      await controller.observe(stalledSnapshot({ lastActivityAt }));
      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0].delivery.attempt).toBe(8);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(8);
      expectNoFailureDeliveryAudit();
    });

    it('store.save 抛错：不交付、错误沿现有传播；恢复后可再次 observe 正常登记', async () => {
      const realStore = makeStore();
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

    it('投递结果 pending：义务持久 attempt1；同窗口/重启重试同 id/body；确认后仍 attempt1，confirmedAt+timeout 才 attempt2（Phase 1842 替换旧「enqueue 失败后跳过整个窗口」语义）', async () => {
      let deliverCount = 0;
      const controller = createExecutionRecoveryController({
        store: makeStore(),
        audit,
        deliverResume: async (request) => {
          resumeCalls.push(request);
          deliverCount++;
          // 第一次交付未证实（写阶段失败），之后证实
          return deliverCount === 1
            ? { kind: 'pending', stage: 'write', error: new Error('inbox down') }
            : { kind: 'confirmed' };
        },
        findPendingResume,
        inspectLlmRecoverySchedule,
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      // 第一次：pending 义务落盘（attempt1），FATAL 审计携带 stage，不抛给智能体
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      const first = readRecordFile(CONTRACT_ID)!;
      expect(first.attempts).toBe(1);
      expect(first.delivery).toMatchObject({ kind: 'pending', attempt: 1, scheduledAt: BASE_NOW });
      const fatal = audit.entries.find(e =>
        e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL &&
        e.some(col => String(col) === 'context=executionRecoveryDelivery'));
      expect(fatal).toBeDefined();
      expect(fatal!.some(col => String(col) === 'stage=write')).toBe(true);
      expect(fatal!.some(col => String(col).includes('inbox down'))).toBe(true);

      // 同窗口重试（重建 controller = 重启）：同一冻结 id/body/attempt，不额外计次
      const controller2 = createExecutionRecoveryController({
        store: makeStore(),
        audit,
        deliverResume: async (request) => {
          resumeCalls.push(request);
          return { kind: 'confirmed' };
        },
        findPendingResume,
        inspectLlmRecoverySchedule,
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      await controller2.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(2);
      expect(resumeCalls[1].delivery.id).toBe(resumeCalls[0].delivery.id);
      expect(resumeCalls[1].delivery.body).toBe(resumeCalls[0].delivery.body);
      expect(resumeCalls[1].delivery.attempt).toBe(1);
      // 确认落盘：仍 attempt1，confirmedAt = 确认时刻
      const confirmed = readRecordFile(CONTRACT_ID)!;
      expect(confirmed.attempts).toBe(1);
      expect(confirmed.delivery).toMatchObject({ kind: 'confirmed', attempt: 1, confirmedAt: BASE_NOW });
      // 当次 observe 不立即登记下一提醒；confirmedAt 之前不产生 attempt2
      await controller2.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(2);
      currentNow += TIMEOUT_MS - 1;
      await controller2.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(2);
      // confirmedAt + timeout：下一逻辑提醒 attempt2（新身份）
      currentNow += 1;
      await controller2.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(3);
      expect(resumeCalls[2].delivery.attempt).toBe(2);
      expect(resumeCalls[2].delivery.id).not.toBe(resumeCalls[0].delivery.id);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(2);
      expectNoFailureDeliveryAudit();
    });

    it('适配器意外 throw：pending 义务保留（错误沿外层传播），下一 observe 以同一 id 补投并确认', async () => {
      let shouldThrow = true;
      const controller = createExecutionRecoveryController({
        store: makeStore(),
        audit,
        deliverResume: async (request) => {
          resumeCalls.push(request);
          if (shouldThrow) {
            shouldThrow = false;
            throw new Error('kaboom');
          }
          return { kind: 'confirmed' };
        },
        findPendingResume,
        inspectLlmRecoverySchedule,
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      await expect(controller.observe(stalledSnapshot())).rejects.toThrow('kaboom');
      // 义务已落盘 pending（throw 不丢义务）
      expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('pending');
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
      // 同窗口下一 observe：同 id 补投并确认，不额外计次
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(2);
      expect(resumeCalls[1].delivery.id).toBe(resumeCalls[0].delivery.id);
      expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('confirmed');
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
    });
  });

  describe('pending 新增抑制（Phase 1843）', () => {
    function expectPendingCheckAudit(present: boolean, messageId?: string): void {
      const hits = audit.entries.filter(e =>
        e.some(col => String(col) === 'context=executionRecoveryPendingCheck'));
      expect(hits).toHaveLength(1);
      const hit = hits[0];
      if (present) {
        expect(hit[0]).toBe(EVENTLOOP_AUDIT_EVENTS.ITERATION);
        expect(hit.some(col => String(col) === 'reason=pending_reminder_exists')).toBe(true);
        expect(hit.some(col => String(col) === `message_id=${messageId}`)).toBe(true);
      } else {
        expect(hit[0]).toBe(EVENTLOOP_AUDIT_EVENTS.FATAL);
      }
    }

    it('无 record 且 pending 已有同契约提醒：不建 record、不交付，审计携带现存 messageId', async () => {
      const { controller } = makeController();
      nextPendingResume = { kind: 'present', messageId: 'old-reminder-1' };
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      expect(pendingResumeCalls).toEqual([CONTRACT_ID]);
      expectPendingCheckAudit(true, 'old-reminder-1');
    });

    it('既有 record（窗口到期）且 pending 已有同契约提醒：原 record 字节不变、attempt 不增、不生成新 ID', async () => {
      const { store, controller } = makeController();
      const existing: ExecutionRecoveryRecord = {
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - TIMEOUT_MS - 1,
        attempts: 2,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      };
      store.save(existing);
      const bytesBefore = fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8');
      nextPendingResume = { kind: 'present', messageId: 'old-reminder-2' };
      await controller.observe(stalledSnapshot());
      expect(fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8')).toBe(bytesBefore);
      expect(resumeCalls).toHaveLength(0);
      expectPendingCheckAudit(true, 'old-reminder-2');
      // 命中不延长窗口：消费后（查询变 absent）同窗口即可登记
      nextPendingResume = { kind: 'absent' };
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(3);
    });

    it('查询未知（throw）：停止本次新增、FATAL 审计携带原错误；恢复后仍能正常登记', async () => {
      const { controller } = makeController();
      pendingResumeError = new Error('peek EIO');
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      expectPendingCheckAudit(false);
      const fatal = audit.entries.find(e =>
        e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL &&
        e.some(col => String(col) === 'context=executionRecoveryPendingCheck'));
      expect(fatal).toBeDefined();
      expect(fatal!.some(col => String(col).includes('peek EIO'))).toBe(true);
      // 恢复后同窗口重试检查并能登记
      pendingResumeError = null;
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
    });

    it('检查顺序：在途/无 active/未超时/确认冷却内不执行 pending 查询', async () => {
      const { controller } = makeController();
      await controller.observe(stalledSnapshot({ turnInFlight: true }));
      await controller.observe(stalledSnapshot({ activeContractId: undefined }));
      await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW - TIMEOUT_MS + 1 }));
      expect(pendingResumeCalls).toHaveLength(0);
      // 登记一次并确认后，confirmedAt 冷却内不再查询
      await controller.observe(stalledSnapshot());
      expect(pendingResumeCalls).toEqual([CONTRACT_ID]);
      expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('confirmed');
      currentNow += TIMEOUT_MS - 1;
      await controller.observe(stalledSnapshot());
      expect(pendingResumeCalls).toHaveLength(1);
      expect(resumeCalls).toHaveLength(1);
    });

    it('已持久 pending 义务绕过新增查询：查询若被调用即 throw，断言 0 调用、义务原样恢复', async () => {
      // 先用正常 absent 查询建立持久 pending 义务（第一次交付未证实）
      let deliverCount = 0;
      const controller = createExecutionRecoveryController({
        store: makeStore(),
        audit,
        deliverResume: async (request) => {
          resumeCalls.push(request);
          deliverCount++;
          return deliverCount === 1
            ? { kind: 'pending', stage: 'write', error: new Error('inbox down') }
            : { kind: 'confirmed' };
        },
        findPendingResume,
        inspectLlmRecoverySchedule,
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      await controller.observe(stalledSnapshot());
      expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('pending');
      // 重建 controller（重启）：旧 pending 义务直接交付恢复，不经新增查询与
      // 安排检查——两者若被调用即 throw（若真被调用会走未知分支、义务永远不被确认）
      const controller2 = createExecutionRecoveryController({
        store: makeStore(),
        audit,
        deliverResume: async (request) => {
          resumeCalls.push(request);
          return { kind: 'confirmed' };
        },
        findPendingResume: async () => { throw new Error('must not query for persisted pending obligation'); },
        inspectLlmRecoverySchedule: async () => { throw new Error('must not inspect for persisted pending obligation'); },
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      await controller2.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(2);
      expect(resumeCalls[1].delivery.id).toBe(resumeCalls[0].delivery.id);
      expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('confirmed');
      // 无 executionRecoveryPendingCheck/ScheduleCheck 审计（检查从未执行）
      expect(audit.entries.some(e =>
        e.some(col => String(col) === 'context=executionRecoveryPendingCheck'))).toBe(false);
      expect(audit.entries.some(e =>
        e.some(col => String(col) === 'context=executionRecoveryScheduleCheck'))).toBe(false);
    });
  });

  describe('LLM 等待期抑制（Phase 1844）', () => {
    const FUTURE_RESUME_AT = new Date(BASE_NOW + 60_000).toISOString();

    function futureAt(revision = 7): LLMRecoverySchedule {
      return { kind: 'at', revision, resumeAt: FUTURE_RESUME_AT };
    }

    function scheduleCheckAudits(): typeof audit.entries {
      return audit.entries.filter(e =>
        e.some(col => String(col) === 'context=executionRecoveryScheduleCheck'));
    }

    it('未来 at：不登记新提醒、不建 record，审计携带 revision/resume_at；不再执行 pending 查询', async () => {
      const { controller } = makeController();
      nextSchedule = futureAt();
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      expect(scheduleInspectCalls).toBe(1);
      // 安排检查在 1843 pending 查询之前：被抑制时不执行 pending 查询
      expect(pendingResumeCalls).toHaveLength(0);
      const hits = scheduleCheckAudits();
      expect(hits).toHaveLength(1);
      expect(hits[0][0]).toBe(EVENTLOOP_AUDIT_EVENTS.ITERATION);
      expect(hits[0].some(col => String(col) === 'reason=llm_retry_scheduled')).toBe(true);
      expect(hits[0].some(col => String(col) === 'schedule_revision=7')).toBe(true);
      expect(hits[0].some(col => String(col) === `resume_at=${FUTURE_RESUME_AT}`)).toBe(true);
    });

    // 非抑制安排：继续原 1843 查询并正常登记（继续登记不等于准入，begin 唯一决定）
    const nonSuppressing: Array<[string, LLMRecoverySchedule | undefined]> = [
      ['ready', { kind: 'ready', revision: 3 }],
      ['on_change', { kind: 'on_change', revision: 4 }],
      ['未注入 owner（undefined）', undefined],
      ['已过期的 at', { kind: 'at', revision: 5, resumeAt: new Date(BASE_NOW - 1000).toISOString() }],
      ['恰好到期的 at（resumeAt === now）', { kind: 'at', revision: 6, resumeAt: new Date(BASE_NOW).toISOString() }],
    ];
    for (const [label, schedule] of nonSuppressing) {
      it(`非抑制安排（${label}）：继续 1843 pending 查询并正常登记`, async () => {
        const { controller } = makeController();
        nextSchedule = schedule;
        await controller.observe(stalledSnapshot());
        expect(scheduleInspectCalls).toBe(1);
        expect(pendingResumeCalls).toEqual([CONTRACT_ID]);
        expect(resumeCalls).toHaveLength(1);
        expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
        expect(scheduleCheckAudits()).toHaveLength(0);
        expectNoFailureDeliveryAudit();
      });
    }

    it('inspect 读取失败（reject）：FATAL 审计携带原错误，不登记、不折 ready；恢复后正常登记', async () => {
      const { controller } = makeController();
      scheduleInspectError = new Error('owner store corrupt');
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      expect(pendingResumeCalls).toHaveLength(0);
      const hits = scheduleCheckAudits();
      expect(hits).toHaveLength(1);
      expect(hits[0][0]).toBe(EVENTLOOP_AUDIT_EVENTS.FATAL);
      expect(hits[0].some(col => String(col).includes('owner store corrupt'))).toBe(true);
      // 恢复后同窗口重试检查并能登记
      scheduleInspectError = null;
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(1);
      expect(readRecordFile(CONTRACT_ID)?.attempts).toBe(1);
    });

    it('非法 resumeAt 日期（类型合法值无效）：FATAL 审计明确协议错误，不登记、不因 NaN 比较放行', async () => {
      const { controller } = makeController();
      nextSchedule = { kind: 'at', revision: 2, resumeAt: 'not-a-date' };
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      expect(pendingResumeCalls).toHaveLength(0);
      const hits = scheduleCheckAudits();
      expect(hits).toHaveLength(1);
      expect(hits[0][0]).toBe(EVENTLOOP_AUDIT_EVENTS.FATAL);
      expect(hits[0].some(col => String(col).includes('invalid LLM resumeAt'))).toBe(true);
    });

    it('未来 at + 既有 confirmed record：record 原字节/次数/确认时间不变，不执行 pending 查询', async () => {
      const { store, controller } = makeController();
      const scheduledAt = BASE_NOW - 10 * TIMEOUT_MS;
      store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - TIMEOUT_MS - 1,
        attempts: 1,
        lastAttemptAt: scheduledAt,
        delivery: {
          kind: 'confirmed',
          id: 'execution_recovery-old',
          attempt: 1,
          scheduledAt,
          body: 'old body',
          confirmedAt: scheduledAt,
        },
      });
      const bytesBefore = fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8');
      nextSchedule = futureAt();
      await controller.observe(stalledSnapshot());
      expect(fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8')).toBe(bytesBefore);
      expect(resumeCalls).toHaveLength(0);
      expect(pendingResumeCalls).toHaveLength(0);
      expect(scheduleCheckAudits()).toHaveLength(1);
    });

    it('检查顺序：在途/无 active/未超时/确认冷却内 inspect 调用 0', async () => {
      const { controller } = makeController();
      nextSchedule = futureAt();
      await controller.observe(stalledSnapshot({ turnInFlight: true }));
      await controller.observe(stalledSnapshot({ retryInFlight: true }));
      await controller.observe(stalledSnapshot({ asyncTaskInFlight: true }));
      await controller.observe(stalledSnapshot({ activeContractId: undefined }));
      await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW - TIMEOUT_MS + 1 }));
      expect(scheduleInspectCalls).toBe(0);
      // 登记一次并确认后，confirmedAt 冷却内不做安排检查
      nextSchedule = undefined;
      await controller.observe(stalledSnapshot());
      expect(scheduleInspectCalls).toBe(1);
      expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('confirmed');
      currentNow += TIMEOUT_MS - 1;
      await controller.observe(stalledSnapshot());
      expect(scheduleInspectCalls).toBe(1);
      expect(resumeCalls).toHaveLength(1);
    });

    it('activity 推进 reset 写保持：旧 pending 转 superseded 后新 epoch 到期仍被未来 at 抑制', async () => {
      const { store, controller } = makeController();
      const oldScheduledAt = BASE_NOW - 20 * TIMEOUT_MS;
      store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - 20 * TIMEOUT_MS,
        attempts: 1,
        lastAttemptAt: oldScheduledAt,
        delivery: {
          kind: 'pending',
          id: 'execution_recovery-stale',
          attempt: 1,
          scheduledAt: oldScheduledAt,
          body: 'stale body',
        },
      });
      // activity 前进（> observedActivityAt）但新 activity 本身仍超时
      const progressedAt = BASE_NOW - TIMEOUT_MS - 1;
      nextSchedule = futureAt();
      await controller.observe(stalledSnapshot({ lastActivityAt: progressedAt }));
      // reset 必要写保持：attempts 归零、旧义务转 superseded（不吞既有证据）
      expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET)).toBe(true);
      const record = readRecordFile(CONTRACT_ID)!;
      expect(record.attempts).toBe(0);
      expect(record.observedActivityAt).toBe(progressedAt);
      expect(record.delivery).toMatchObject({ kind: 'superseded', id: 'execution_recovery-stale' });
      // 只有新登记被未来 at 挡住：不交付、不查 pending
      expect(resumeCalls).toHaveLength(0);
      expect(pendingResumeCalls).toHaveLength(0);
      expect(scheduleCheckAudits()).toHaveLength(1);
    });

    it('旧共享基线导入写保持：legacy 继承照常落盘，新登记被未来 at 抑制', async () => {
      const legacyRaw = JSON.stringify({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - TIMEOUT_MS - 1,
        attempts: 3,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      });
      fs.mkdirSync(path.dirname(legacyRecordFilePath(CONTRACT_ID)), { recursive: true });
      fs.writeFileSync(legacyRecordFilePath(CONTRACT_ID), legacyRaw);
      const { controller } = makeController();
      nextSchedule = futureAt();
      await controller.observe(stalledSnapshot());
      // 继承写保持：本地 record 建立（attempts 3 + unknown 来源证据），root 原文不变
      const record = readRecordFile(CONTRACT_ID)!;
      expect(record.attempts).toBe(3);
      expect(record.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
      expect(fs.readFileSync(legacyRecordFilePath(CONTRACT_ID), 'utf8')).toBe(legacyRaw);
      expect(resumeCalls).toHaveLength(0);
      expect(scheduleCheckAudits()).toHaveLength(1);
    });

    it('已持久 pending 义务 + inspect 抛错：inspect 0 调用，义务按原身份恢复确认', async () => {
      // 先用正常流程建立持久 pending 义务（第一次交付未证实）
      let deliverCount = 0;
      const controller = createExecutionRecoveryController({
        store: makeStore(),
        audit,
        deliverResume: async (request) => {
          resumeCalls.push(request);
          deliverCount++;
          return deliverCount === 1
            ? { kind: 'pending', stage: 'write', error: new Error('inbox down') }
            : { kind: 'confirmed' };
        },
        findPendingResume,
        inspectLlmRecoverySchedule,
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      await controller.observe(stalledSnapshot());
      expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('pending');
      expect(scheduleInspectCalls).toBe(1);
      // 重建 controller（重启）：旧 pending 义务直接恢复，即使 inspect 会抛错也不调用
      const controller2 = createExecutionRecoveryController({
        store: makeStore(),
        audit,
        deliverResume: async (request) => {
          resumeCalls.push(request);
          return { kind: 'confirmed' };
        },
        findPendingResume,
        inspectLlmRecoverySchedule: async () => { throw new Error('must not inspect for persisted pending obligation'); },
        timeoutMs: TIMEOUT_MS,
        now: () => currentNow,
      });
      await controller2.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(2);
      expect(resumeCalls[1].delivery.id).toBe(resumeCalls[0].delivery.id);
      expect(readRecordFile(CONTRACT_ID)?.delivery?.kind).toBe('confirmed');
      expect(scheduleInspectCalls).toBe(1);
    });

    it('未来 at → 到期：推进共享时间后同一契约可登记 attempt1 并交付，无额外固定冷却', async () => {
      const { controller } = makeController();
      nextSchedule = futureAt();
      await controller.observe(stalledSnapshot());
      expect(resumeCalls).toHaveLength(0);
      expect(fs.existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
      // 推进到 deadline（resumeAt === now 已到期）：同一观察路径登记并交付
      currentNow = BASE_NOW + 60_000;
      nextSchedule = { kind: 'at', revision: 7, resumeAt: FUTURE_RESUME_AT };
      await controller.observe(stalledSnapshot({ lastActivityAt: BASE_NOW - TIMEOUT_MS - 1 }));
      expect(scheduleInspectCalls).toBe(2);
      expect(pendingResumeCalls).toEqual([CONTRACT_ID]);
      expect(resumeCalls).toHaveLength(1);
      const record = readRecordFile(CONTRACT_ID)!;
      expect(record.attempts).toBe(1);
      expect(record.delivery?.kind).toBe('confirmed');
    });
  });

  // Phase 1842: 原「真实 notifyInbox 回调投递读回」用例已迁至
  // execution-recovery-delivery.test.ts，改经实际 EventLoop 适配器 + 真实
  // Messaging 链验收（不再以 notify 回调返回冒充投递确认）。

  describe('store', () => {
    it('save/load/覆盖 roundtrip（Phase 1841：store 不再提供 delete/list）', () => {
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
      const updated: ExecutionRecoveryRecord = { ...record, attempts: 3, lastAttemptAt: 789 };
      store.save(updated);
      expect(store.load(CONTRACT_ID)).toEqual(updated);
      // legacy 目录全程未被写入
      expect(fs.existsSync(legacyRecordFilePath(CONTRACT_ID))).toBe(false);
    });

    it('损坏 record：load 审计后抛出（Phase 1841：读取未知不降格为不存在），原字节不变', () => {
      const { store } = makeController();
      fs.mkdirSync(path.join(agentDir, EXECUTION_RECOVERY_DIR), { recursive: true });
      fs.writeFileSync(recordFilePath(CONTRACT_ID), 'not-json{{{');
      const bytesBefore = fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8');
      expect(() => store.load(CONTRACT_ID)).toThrow();
      expect(fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8')).toBe(bytesBefore);
      const fatal = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL);
      expect(fatal).toBeDefined();
      expect(fatal!.some(col => String(col) === 'scope=local')).toBe(true);
      expect(fatal!.some(col => String(col) === 'reason=parse_failed')).toBe(true);
    });

    it('delivery schema roundtrip：pending / confirmed / superseded 及重置后保留证据均合法', () => {
      const { store } = makeController();
      const base = {
        schema_version: 1 as const,
        contractId: CONTRACT_ID,
        observedActivityAt: 100,
      };
      const pending: ExecutionRecoveryRecord = {
        ...base,
        attempts: 2,
        lastAttemptAt: 456,
        delivery: { kind: 'pending', id: 'execution_recovery-abc', attempt: 2, scheduledAt: 456, body: 'b' },
      };
      store.save(pending);
      expect(store.load(CONTRACT_ID)).toEqual(pending);

      const confirmed: ExecutionRecoveryRecord = {
        ...pending,
        delivery: { kind: 'confirmed', id: 'execution_recovery-abc', attempt: 2, scheduledAt: 456, body: 'b', confirmedAt: 789 },
      };
      store.save(confirmed);
      expect(store.load(CONTRACT_ID)).toEqual(confirmed);

      // activity 重置后（attempts=0/lastAttemptAt=0）保留旧 confirmed / superseded 证据
      const resetConfirmed: ExecutionRecoveryRecord = {
        ...base,
        attempts: 0,
        lastAttemptAt: 0,
        delivery: confirmed.delivery,
      };
      store.save(resetConfirmed);
      expect(store.load(CONTRACT_ID)).toEqual(resetConfirmed);

      const superseded: ExecutionRecoveryRecord = {
        ...base,
        attempts: 0,
        lastAttemptAt: 0,
        delivery: {
          kind: 'superseded', id: 'execution_recovery-abc', attempt: 2, scheduledAt: 456, body: 'b',
          supersededAt: 999, reason: 'activity_progressed',
        },
      };
      store.save(superseded);
      expect(store.load(CONTRACT_ID)).toEqual(superseded);
    });

    it('坏本地 delivery：显式 null / 未知 kind / 坏 id / 非正 attempt / 空 body / 与顶部计数不一致 → load 审计后抛出，原字节不变，不重置不继承', () => {
      const { store } = makeController();
      const baseFields = {
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: 100,
        attempts: 2,
        lastAttemptAt: 456,
      };
      const validPending = { kind: 'pending', id: 'execution_recovery-abc', attempt: 2, scheduledAt: 456, body: 'b' };
      const badDeliveries: unknown[] = [
        null,
        { ...validPending, kind: 'done' },
        { ...validPending, id: 'other-prefix-abc' },
        { ...validPending, id: 'execution_recovery-' },
        { ...validPending, attempt: 0 },
        { ...validPending, body: '' },
        { ...validPending, scheduledAt: Number.POSITIVE_INFINITY },
        { ...validPending, scheduledAt: 8.64e15 + 1 },
        // pending 与顶部计数不一致（attempt / scheduledAt 必须等于 record.attempts / lastAttemptAt）
        { ...validPending, attempt: 3 },
        { ...validPending, scheduledAt: 457 },
        // confirmed 缺 confirmedAt / superseded 缺 reason 精确值 / superseded 在零基线以外
        { kind: 'confirmed', id: 'execution_recovery-abc', attempt: 2, scheduledAt: 456, body: 'b' },
        { kind: 'superseded', id: 'execution_recovery-abc', attempt: 2, scheduledAt: 456, body: 'b', supersededAt: 999, reason: 'other' },
        { kind: 'superseded', id: 'execution_recovery-abc', attempt: 2, scheduledAt: 456, body: 'b', supersededAt: 999, reason: 'activity_progressed' },
      ];
      fs.mkdirSync(path.join(agentDir, EXECUTION_RECOVERY_DIR), { recursive: true });
      for (const delivery of badDeliveries) {
        const raw = JSON.stringify({ ...baseFields, delivery });
        fs.writeFileSync(recordFilePath(CONTRACT_ID), raw);
        expect(() => store.load(CONTRACT_ID)).toThrow(/schema invalid/);
        expect(fs.readFileSync(recordFilePath(CONTRACT_ID), 'utf8')).toBe(raw);
        const fatal = audit.entries[audit.entries.length - 1];
        expect(fatal[0]).toBe(EVENTLOOP_AUDIT_EVENTS.FATAL);
        expect(fatal.some(col => String(col) === 'reason=schema_invalid')).toBe(true);
      }
    });
  });
});
