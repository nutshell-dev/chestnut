/**
 * Phase 1842: 提醒交付义务真实链验收 —— 真实 NodeFileSystem / store / controller /
 * EventLoop 投递适配（protected 仅由类型化测试子类暴露）/ Messaging
 * （writeInboxAsync + InboxReader.findByExtraMeta）。
 *
 * 边界纪律：
 * - 故障只在 Fs 边界注入（异步 writeAtomic / list），或按 record 内容 kind 定点
 *   注入 store.save；不 mock findByExtraMeta 来证明真实查找，不手抄产品实现；
 * - 测试子类只暴露适配器，不复制控制逻辑；
 * - post-null（写后证据被移走）是故障注入场景，不是正常串行路径（正常链中
 *   写完同目录即可见）；
 * - confirmed 只证明 Messaging 消息存在证据，不证明 LLM 已执行或契约有进展。
 *
 * 覆盖 B§6 矩阵：新到期提醒 / 写前 EIO / 写已提交后 throw / pre-query EIO /
 * post-query EIO 与 post-null / 确认保存失败 / pending-inflight-done 三位置 /
 * delayed confirm / 新活动 supersede / 无 active·在途·切换 / run 装配见
 * event-loop.test.ts。
 * Phase 1843: 登记前 pending 精确匹配抑制（真实 _findPendingExecutionResume 接线）——
 * 未消费跨窗口/重启不新增、消费后窗口恢复新增、旧格式/旧 epoch/多条积压匹配、
 * 三要素精确边界、登记前 peek 故障停止本次新增。故障注入不按 list 调用次数猜阶段
 * （新增 peek 也走同一 list）：pre-query 先以写 EIO 建立持久 pending 再注入；
 * post-query 以「写已提交」标记门控。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createExecutionRecoveryStore,
  createExecutionRecoveryController,
  type ExecutionRecoveryController,
  type ExecutionRecoveryDelivery,
  type ExecutionRecoveryDeliveryOutcome,
  type ExecutionRecoveryDeliveryRequest,
  type ExecutionRecoveryStore,
  type ExecutionActivitySnapshot,
  type ExecutionRecoveryRecord,
  type PendingExecutionResume,
} from '../../../src/core/event-loop/execution-recovery.js';
import { EventLoop } from '../../../src/core/event-loop/event-loop.js';
import {
  EXECUTION_RECOVERY_DIR,
  EXECUTION_RECOVERY_DELIVERY_META_KEY,
} from '../../../src/core/event-loop/constants.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createInboxReader, decodeInbox, writeInboxAsync } from '../../../src/foundation/messaging/index.js';
import type { InboxMessage } from '../../../src/foundation/messaging/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createTrackedTempDirSync } from '../../utils/temp.js';

const TIMEOUT_MS = 1000;
const BASE_NOW = 1_700_000_000_000;
const CONTRACT_ID = '1700000000000-abcd';
const CLAW_ID = 'claw-1';

function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

/** 类型化测试子类：只公开真实 protected 适配器，不复制控制逻辑。 */
class TestEventLoop extends EventLoop {
  deliverExecutionResume(
    request: ExecutionRecoveryDeliveryRequest,
  ): Promise<ExecutionRecoveryDeliveryOutcome> {
    return this._deliverExecutionResume(request);
  }

  /** Phase 1843: 登记前 owner pending 查询适配（真实 peekPending 链）。 */
  findPendingExecutionResume(contractId: string): Promise<PendingExecutionResume> {
    return this._findPendingExecutionResume(contractId);
  }
}

interface Harness {
  rootDir: string;
  agentDir: string;
  pendingDir: string;
  agentFs: NodeFileSystem;
  audit: ReturnType<typeof createMockAudit>;
  requests: ExecutionRecoveryDeliveryRequest[];
  loop: TestEventLoop;
  store: ExecutionRecoveryStore;
  controller: ExecutionRecoveryController;
}

describe('execution-recovery delivery obligation (phase 1842)', () => {
  let currentNow: number;
  let cleanups: string[];

  beforeEach(() => {
    currentNow = BASE_NOW;
    cleanups = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 真实链 harness：EventLoop 适配 + 真实 store/controller/Messaging。 */
  function makeHarness(prefix: string): Harness {
    const rootDir = createTrackedTempDirSync(prefix);
    cleanups.push(rootDir);
    const agentDir = path.join(rootDir, 'claws', CLAW_ID);
    const pendingDir = path.join(agentDir, 'inbox', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const agentFs = new NodeFileSystem({ baseDir: agentDir });
    const audit = createMockAudit();
    const requests: ExecutionRecoveryDeliveryRequest[] = [];
    // EventLoop 构造只用 agentDir 推导自身 fs；提供共享 agentFs 以便 Fs 边界注入。
    const loop = new TestEventLoop({
      runtime: {} as never,
      fsFactory: (dir: string) => (dir === agentDir ? agentFs : new NodeFileSystem({ baseDir: dir })),
      agentDir,
      clawId: CLAW_ID,
      audit,
      inbox: { pendingDir },
    });
    const store = createExecutionRecoveryStore({ agentFs, audit });
    const controller = createExecutionRecoveryController({
      store,
      audit,
      deliverResume: async (request) => {
        requests.push(request);
        return loop.deliverExecutionResume(request);
      },
      findPendingResume: (contractId) => loop.findPendingExecutionResume(contractId),
      // Phase 1844: 本文件不注入 LLM recovery owner——显式 undefined（未注入语义）。
      inspectLlmRecoverySchedule: async () => undefined,
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
    return { rootDir, agentDir, pendingDir, agentFs, audit, requests, loop, store, controller };
  }

  /** 只重建 store/controller（模拟重启），Fs/inbox/audit/requests 不变。 */
  function reopen(h: Harness): void {
    h.store = createExecutionRecoveryStore({ agentFs: h.agentFs, audit: h.audit });
    h.controller = createExecutionRecoveryController({
      store: h.store,
      audit: h.audit,
      deliverResume: async (request) => {
        h.requests.push(request);
        return h.loop.deliverExecutionResume(request);
      },
      findPendingResume: (contractId) => h.loop.findPendingExecutionResume(contractId),
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

  function recordPath(h: Harness, contractId: string): string {
    return path.join(h.agentDir, EXECUTION_RECOVERY_DIR, `${contractId}.json`);
  }

  function readRecord(h: Harness, contractId: string): ExecutionRecoveryRecord | null {
    const p = recordPath(h, contractId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ExecutionRecoveryRecord;
  }

  function pendingFiles(h: Harness): string[] {
    return fs.readdirSync(h.pendingDir).filter(f => f.endsWith('.md'));
  }

  function readPendingMessages(h: Harness): InboxMessage[] {
    return pendingFiles(h).map(f =>
      decodeInbox(fs.readFileSync(path.join(h.pendingDir, f), 'utf8')));
  }

  function deliveryFatal(h: Harness, stage: string): boolean {
    return h.audit.entries.some(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL &&
      e.some(col => String(col) === 'context=executionRecoveryDelivery') &&
      e.some(col => String(col) === `stage=${stage}`));
  }

  /** Fs 边界：inbox 消息（.md）的异步 writeAtomic 注入。 */
  function failInboxWrites(h: Harness, mode: 'before_commit' | 'after_commit'): () => void {
    const realWrite = h.agentFs.writeAtomic.bind(h.agentFs);
    const spy = vi.spyOn(h.agentFs, 'writeAtomic').mockImplementation(async (p, content) => {
      if (String(p).endsWith('.md')) {
        if (mode === 'after_commit') await realWrite(p, content);
        throw Object.assign(new Error('probe inbox EIO'), { code: 'EIO' });
      }
      return realWrite(p, content);
    });
    return () => spy.mockRestore();
  }

  /**
   * Fs 边界：owner pending 目录 list 无条件抛 EIO（返回恢复函数）。
   * Phase 1843：不按第 N 次 list 猜阶段（登记前 peek 也走同一 list）；调用方
   * 负责先建立目标阶段，再注入本故障。
   */
  function failPendingListEIO(h: Harness): () => void {
    const realList = h.agentFs.list.bind(h.agentFs);
    const spy = vi.spyOn(h.agentFs, 'list').mockImplementation(async (p, opts) => {
      if (String(p).replace(/\\/g, '/').endsWith('inbox/pending')) {
        throw Object.assign(new Error('probe query EIO'), { code: 'EIO' });
      }
      return realList(p, opts);
    });
    return () => spy.mockRestore();
  }

  /** Fs 边界：owner pending 目录内消息文件 read 无条件抛 EIO（peekPending → PendingViewError）。 */
  function failPendingReadEIO(h: Harness): () => void {
    const realRead = h.agentFs.read.bind(h.agentFs);
    const spy = vi.spyOn(h.agentFs, 'read').mockImplementation(async (p) => {
      if (String(p).replace(/\\/g, '/').includes('inbox/pending/')) {
        throw Object.assign(new Error('probe read EIO'), { code: 'EIO' });
      }
      return realRead(p);
    });
    return () => spy.mockRestore();
  }

  /** store.save 按 record 内容 kind 定点注入（不允许误打其他转换）。 */
  function failConfirmSave(h: Harness): () => void {
    const realSave = h.store.save.bind(h.store);
    const orig = h.controller;
    void orig;
    h.controller = createExecutionRecoveryController({
      store: {
        load: h.store.load.bind(h.store),
        save: (record) => {
          if (record.delivery?.kind === 'confirmed') {
            throw Object.assign(new Error('EIO confirm save'), { code: 'EIO' });
          }
          realSave(record);
        },
      },
      audit: h.audit,
      deliverResume: async (request) => {
        h.requests.push(request);
        return h.loop.deliverExecutionResume(request);
      },
      findPendingResume: (contractId) => h.loop.findPendingExecutionResume(contractId),
      inspectLlmRecoverySchedule: async () => undefined,
      timeoutMs: TIMEOUT_MS,
      now: () => currentNow,
    });
    return () => reopen(h);
  }

  // -------------------------------------------------------------------------
  // 新到期提醒：pending 先落盘 → 写 → owner 后查询命中才 confirmed
  // -------------------------------------------------------------------------

  it('新到期提醒：先有本地 pending 再写；唯一逻辑 ID/body；owner 后查询命中才保存 confirmed；解码消息关联正确', async () => {
    const h = makeHarness('delivery-happy-');
    // 断言写消息之前磁盘上已有 pending 义务（同一冻结 id）
    let recordAtWrite: ExecutionRecoveryRecord | null = null;
    const realWrite = h.agentFs.writeAtomic.bind(h.agentFs);
    vi.spyOn(h.agentFs, 'writeAtomic').mockImplementation(async (p, content) => {
      if (String(p).endsWith('.md')) recordAtWrite = readRecord(h, CONTRACT_ID);
      return realWrite(p, content);
    });

    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));

    expect(h.requests).toHaveLength(1);
    const delivery = h.requests[0].delivery;
    // 写消息时本地义务已是 pending 且 id 一致
    expect(recordAtWrite?.delivery).toMatchObject({ kind: 'pending', id: delivery.id, attempt: 1 });
    // owner 后查询命中才 confirmed
    const record = readRecord(h, CONTRACT_ID)!;
    expect(record.attempts).toBe(1);
    expect(record.delivery).toMatchObject({
      kind: 'confirmed',
      id: delivery.id,
      attempt: 1,
      scheduledAt: BASE_NOW,
      body: delivery.body,
      confirmedAt: BASE_NOW,
    });
    // 解码消息关联正确（metadata 关联键，不从文件名推身份）
    const messages = readPendingMessages(h);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(delivery.id);
    expect(messages[0].type).toBe('execution_recovery');
    expect(messages[0].from).toBe(CLAW_ID);
    expect(messages[0].priority).toBe('high');
    expect(messages[0].content).toBe(delivery.body);
    expect(messages[0].timestamp).toBe(new Date(BASE_NOW).toISOString());
    expect(messages[0].metadata?.contract_id).toBe(CONTRACT_ID);
    expect(messages[0].metadata?.[EXECUTION_RECOVERY_DELIVERY_META_KEY]).toBe(delivery.id);
    // owner 生成的文件名含另一个 UUID，不等于 delivery.id
    expect(pendingFiles(h)[0]).not.toContain(delivery.id);
  });

  // -------------------------------------------------------------------------
  // 写前 EIO：pending 保留、0 消息；恢复后原窗口内补投同 id/body
  // -------------------------------------------------------------------------

  it('写前 EIO：record pending/attempt1、0 消息；恢复写入并重建 controller，原窗口内补投成功（同 id/body/attempt1）', async () => {
    const h = makeHarness('delivery-write-eio-');
    const restore = failInboxWrites(h, 'before_commit');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'pending', attempt: 1 });
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(1);
    expect(pendingFiles(h)).toHaveLength(0);
    expect(deliveryFatal(h, 'write')).toBe(true);
    const failedId = h.requests[0].delivery.id;
    const failedBody = h.requests[0].delivery.body;

    // 恢复写入 + 重建 controller（重启），同窗口：补投同一义务
    restore();
    reopen(h);
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].delivery.id).toBe(failedId);
    expect(h.requests[1].delivery.body).toBe(failedBody);
    expect(h.requests[1].delivery.attempt).toBe(1);
    expect(pendingFiles(h)).toHaveLength(1);
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: failedId, attempt: 1 });
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 写已提交后 throw：第一回 pending 但已有 1 文件；重建后预查询命中不再写
  // -------------------------------------------------------------------------

  it('写已提交后 throw：第一回 pending 但已有 1 文件；重建后预查询命中，不再写，第 1 ID 确认', async () => {
    const h = makeHarness('delivery-commit-throw-');
    const restore = failInboxWrites(h, 'after_commit');
    const writeSpy = h.agentFs.writeAtomic as ReturnType<typeof vi.spyOn>;
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    // 写实际已提交但回调抛错 → 义务仍 pending（不当成功也不立刻重写）
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');
    expect(pendingFiles(h)).toHaveLength(1);
    expect(deliveryFatal(h, 'write')).toBe(true);
    const firstId = h.requests[0].delivery.id;
    const mdWritesBefore = writeSpy.mock.calls.filter(c => String(c[0]).endsWith('.md')).length;
    expect(mdWritesBefore).toBe(1);
    restore();

    // 重建后：预查询命中（pending 位置），不再写，直接确认第 1 ID
    reopen(h);
    // Phase 1843：spy 必须在 observe 之前挂上——此前在 observe 之后建立的空断言无效。
    const writeSpy2 = vi.spyOn(h.agentFs, 'writeAtomic');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].delivery.id).toBe(firstId);
    expect(writeSpy2).not.toHaveBeenCalled();
    expect(pendingFiles(h)).toHaveLength(1);
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: firstId, attempt: 1 });
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(1);
  });

  // -------------------------------------------------------------------------
  // pre-query EIO：保留 pending，0 次写；不得当 absent；恢复后可继续
  // -------------------------------------------------------------------------

  it('pre-query EIO：保留 pending、0 次写（查询失败不当 absent）；恢复后同 id 补投确认', async () => {
    const h = makeHarness('delivery-pre-query-eio-');
    // Phase 1843：不按 list 调用次数猜阶段——先以真实写前 EIO 建立持久 pending
    // 义务（0 消息），恢复写入并重建 controller，再注入 list EIO；这样走已持久
    // 义务的投递链（绕过登记前新增查询），仍测 query_before。
    const restoreWrite = failInboxWrites(h, 'before_commit');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');
    expect(pendingFiles(h)).toHaveLength(0);
    expect(deliveryFatal(h, 'write')).toBe(true);
    const firstId = h.requests[0].delivery.id;
    restoreWrite();
    reopen(h);

    const restoreList = failPendingListEIO(h);
    const writeSpy = vi.spyOn(h.agentFs, 'writeAtomic');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(pendingFiles(h)).toHaveLength(0);
    expect(deliveryFatal(h, 'query_before')).toBe(true);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].delivery.id).toBe(firstId);
    restoreList();

    reopen(h);
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2].delivery.id).toBe(firstId);
    expect(pendingFiles(h)).toHaveLength(1);
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: firstId });
  });

  // -------------------------------------------------------------------------
  // post-query EIO：保留 pending/stage=query_after，不能 false confirmed
  // -------------------------------------------------------------------------

  it('post-query EIO：写已提交但写后查询失败 → pending/stage=query_after；恢复后同 ID 确认、不补第二份', async () => {
    const h = makeHarness('delivery-post-query-eio-');
    // Phase 1843：不按第 2 次 list 猜阶段——真实 writeAtomic 成功后置 committed
    // 标记，此后 pending list 才抛 EIO；恢复时清标记并恢复 spy。
    let committed = false;
    const realWrite = h.agentFs.writeAtomic.bind(h.agentFs);
    const writeMock = vi.spyOn(h.agentFs, 'writeAtomic').mockImplementation(async (p, content) => {
      const result = await realWrite(p, content);
      if (String(p).endsWith('.md')) committed = true;
      return result;
    });
    const realList = h.agentFs.list.bind(h.agentFs);
    const listMock = vi.spyOn(h.agentFs, 'list').mockImplementation(async (p, opts) => {
      if (committed && String(p).replace(/\\/g, '/').endsWith('inbox/pending')) {
        throw Object.assign(new Error('probe query EIO'), { code: 'EIO' });
      }
      return realList(p, opts);
    });
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');
    expect(pendingFiles(h)).toHaveLength(1);
    expect(deliveryFatal(h, 'query_after')).toBe(true);
    const firstId = h.requests[0].delivery.id;
    committed = false;
    writeMock.mockRestore();
    listMock.mockRestore();

    reopen(h);
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests[1].delivery.id).toBe(firstId);
    expect(pendingFiles(h)).toHaveLength(1); // 不补第二份
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: firstId });
  });

  it('post-null（故障注入移走证据，非正常串行路径）：写后查询无证据 → pending 不 false confirmed；证据恢复后同 ID 确认', async () => {
    const h = makeHarness('delivery-post-null-');
    // 写已真实提交，随后在适配器写后查询之前把文件移出 inbox 目录（模拟外部搬移
    // 证据的故障场景；正常单实例串行链写完同目录即可见，不会走这条路）。
    const realWrite = h.agentFs.writeAtomic.bind(h.agentFs);
    let movedBack: (() => void) | null = null;
    vi.spyOn(h.agentFs, 'writeAtomic').mockImplementation(async (p, content) => {
      const result = await realWrite(p, content);
      if (String(p).endsWith('.md')) {
        const file = pendingFiles(h)[0];
        const stashed = path.join(h.rootDir, 'stashed.md');
        fs.renameSync(path.join(h.pendingDir, file), stashed);
        movedBack = () => fs.renameSync(stashed, path.join(h.pendingDir, file));
      }
      return result;
    });

    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    // 写后查询无证据：不能 false confirmed
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');
    expect(deliveryFatal(h, 'query_after')).toBe(true);
    expect(pendingFiles(h)).toHaveLength(0);
    const firstId = h.requests[0].delivery.id;

    // 证据恢复（文件移回 pending）→ 同 ID 确认，不补第二份
    movedBack!();
    reopen(h);
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].delivery.id).toBe(firstId);
    expect(pendingFiles(h)).toHaveLength(1);
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: firstId });
  });

  // -------------------------------------------------------------------------
  // 确认保存失败：inbox 1 份、磁盘 pending；重建再查询确认，物理写总数 1
  // -------------------------------------------------------------------------

  it('confirmation save 在 rename 前失败：inbox 1 份、磁盘 pending；重建再查询确认，物理写总数 1', async () => {
    const h = makeHarness('delivery-confirm-save-fail-');
    const restore = failConfirmSave(h);
    await expect(h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1)))
      .rejects.toThrow('EIO confirm save');
    // 消息已写入，但确认未落盘 → 磁盘仍是 pending
    expect(pendingFiles(h)).toHaveLength(1);
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');
    const firstId = h.requests[0].delivery.id;
    restore();

    // 重建：预查询命中原消息 → 确认保存成功；全程物理写总数 1
    const writeSpy = vi.spyOn(h.agentFs, 'writeAtomic');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].delivery.id).toBe(firstId);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(pendingFiles(h)).toHaveLength(1);
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: firstId, attempt: 1 });
  });

  // -------------------------------------------------------------------------
  // pending / inflight / done 三位置：每位置重建 controller 后都确认同 id，无新写
  // -------------------------------------------------------------------------

  it('pending/inflight/done 三位置均可确认同一义务（真实 reader drain/ack 移动）；done 跨大于 timeout 仍可找到', async () => {
    // 每个位置独立 harness：先让义务 pending 且消息已真实写入（写已提交后 throw），
    // 再用真实 reader 把消息移动到目标位置，重建 controller 后预查询命中确认。
    const setupPendingWithMessage = async (prefix: string): Promise<Harness> => {
      const h = makeHarness(prefix);
      const restore = failInboxWrites(h, 'after_commit');
      await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
      restore();
      expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');
      expect(pendingFiles(h)).toHaveLength(1);
      return h;
    };

    // 1) pending 位置
    const hp = await setupPendingWithMessage('delivery-loc-pending-');
    reopen(hp);
    await hp.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(hp, CONTRACT_ID)?.delivery?.kind).toBe('confirmed');
    expect(pendingFiles(hp)).toHaveLength(1);

    // 2) inflight 位置（真实 drain 移动，不 ack）
    const hi = await setupPendingWithMessage('delivery-loc-inflight-');
    const inflightReader = createInboxReader(hi.agentFs, hi.audit, 'inbox');
    const batch = await inflightReader.drainAndDeliver();
    expect(batch.kind).toBe('complete');
    if (batch.kind !== 'complete') throw new Error('unexpected batch kind');
    expect(batch.entries).toHaveLength(1);
    reopen(hi);
    await hi.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(hi, CONTRACT_ID)?.delivery?.kind).toBe('confirmed');
    expect(hi.requests).toHaveLength(2);
    expect(hi.requests[1].delivery.id).toBe(hi.requests[0].delivery.id);

    // 3) done 位置（真实 drain + ack；跨过多个 timeout 仍可找到，不补写、不加 attempt）
    const hd = await setupPendingWithMessage('delivery-loc-done-');
    const doneReader = createInboxReader(hd.agentFs, hd.audit, 'inbox');
    const doneBatch = await doneReader.drainAndDeliver();
    expect(doneBatch.kind).toBe('complete');
    if (doneBatch.kind !== 'complete') throw new Error('unexpected batch kind');
    await doneReader.ack(doneBatch.handles[0]);
    currentNow += 10 * TIMEOUT_MS; // done 已远旧于窗口
    reopen(hd);
    const writeSpy = vi.spyOn(hd.agentFs, 'writeAtomic');
    await hd.controller.observe(stalled(CONTRACT_ID, BASE_NOW - 11 * TIMEOUT_MS));
    expect(readRecord(hd, CONTRACT_ID)?.delivery).toMatchObject({
      kind: 'confirmed',
      id: hd.requests[0].delivery.id,
      attempt: 1,
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readRecord(hd, CONTRACT_ID)?.attempts).toBe(1);
  });

  // -------------------------------------------------------------------------
  // delayed confirm：大于原窗口才成功仍 attempt1；下一次逻辑提醒等 confirmedAt+timeout
  // -------------------------------------------------------------------------

  it('delayed confirm：跨多个原窗口才确认仍 attempt1（当次不生成 attempt2）；未消费时边界仍不新增；drain+ack 原消息后 confirmedAt+timeout 才 attempt2', async () => {
    const h = makeHarness('delivery-delayed-');
    const restore = failInboxWrites(h, 'before_commit');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');
    const firstId = h.requests[0].delivery.id;
    restore();

    // 跨过 5 个原窗口才恢复：仍补投同一 attempt1 义务，不产生 attempt2
    currentNow += 5 * TIMEOUT_MS;
    reopen(h);
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].delivery.id).toBe(firstId);
    expect(h.requests[1].delivery.attempt).toBe(1);
    const record = readRecord(h, CONTRACT_ID)!;
    expect(record.attempts).toBe(1);
    expect(record.delivery).toMatchObject({ kind: 'confirmed', attempt: 1, confirmedAt: currentNow });

    // 下一逻辑提醒窗口自 confirmedAt 起算
    const confirmedAt = currentNow;
    currentNow = confirmedAt + TIMEOUT_MS - 1;
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(2);
    // Phase 1843：原消息仍 pending 未消费——边界也不新增（pending 提醒本身是
    // 待消费唤醒机会），不是冷却失效
    currentNow = confirmedAt + TIMEOUT_MS;
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(2);
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(1);
    const suppressedAudit = h.audit.entries.find(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION &&
      e.some(col => String(col) === 'context=executionRecoveryPendingCheck') &&
      e.some(col => String(col) === 'reason=pending_reminder_exists'));
    expect(suppressedAudit).toBeDefined();
    expect(suppressedAudit!.some(col => String(col) === `message_id=${firstId}`)).toBe(true);

    // 真实 drain+ack 消费原消息（消费不等于契约完成，不人为推进 activity）
    const reader = createInboxReader(h.agentFs, h.audit, 'inbox');
    const batch = await reader.drainAndDeliver();
    expect(batch.kind).toBe('complete');
    if (batch.kind !== 'complete') throw new Error('unexpected batch kind');
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0].message.id).toBe(firstId);
    await reader.ack(batch.handles[0]);
    expect(pendingFiles(h)).toHaveLength(0);

    // 消费后同一边界窗口：查询 absent → 登记下一逻辑提醒 attempt2（新身份）
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2].delivery.attempt).toBe(2);
    expect(h.requests[2].delivery.id).not.toBe(firstId);
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 新活动与 pending：superseded 落盘、证据保留、不再交付旧义务
  // -------------------------------------------------------------------------

  it('新活动使旧 pending 转 superseded：落盘保留同 identity/body 证据、不再交付旧义务；reset 写失败不能发；新 epoch 仍可到期正常登记', async () => {
    const h = makeHarness('delivery-supersede-');
    const restore = failInboxWrites(h, 'before_commit');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    restore();
    const oldId = h.requests[0].delivery.id;
    const oldBody = h.requests[0].delivery.body;
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('pending');

    // 新活动推进：reset 写失败 → 抛出、旧记录原字节不变、不交付
    const bytesBefore = fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8');
    vi.spyOn(h.agentFs, 'writeAtomicSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO reset'), { code: 'EIO' });
    });
    await expect(h.controller.observe(stalled(CONTRACT_ID, BASE_NOW))).rejects.toThrow('EIO reset');
    expect(fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8')).toBe(bytesBefore);
    expect(h.requests).toHaveLength(1);
    vi.restoreAllMocks();

    // reset 成功：superseded 落盘，保留旧 identity/body 证据；当次不交付旧义务
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW));
    const superseded = readRecord(h, CONTRACT_ID)!;
    expect(superseded).toMatchObject({ attempts: 0, lastAttemptAt: 0, observedActivityAt: BASE_NOW });
    expect(superseded.delivery).toMatchObject({
      kind: 'superseded',
      id: oldId,
      body: oldBody,
      attempt: 1,
      supersededAt: currentNow,
      reason: 'activity_progressed',
    });
    expect(h.requests).toHaveLength(1); // 旧义务不再交付
    const resetAudit = h.audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET);
    expect(resetAudit).toBeDefined();
    expect(String(resetAudit!.find(col => String(col).startsWith('previous_record=')))).toContain(oldId);

    // 新 epoch 到期：登记全新 pending（新身份），正常投递确认
    currentNow += TIMEOUT_MS;
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].delivery.attempt).toBe(1);
    expect(h.requests[1].delivery.id).not.toBe(oldId);
    expect(readRecord(h, CONTRACT_ID)?.delivery?.kind).toBe('confirmed');
  });

  // -------------------------------------------------------------------------
  // 无 active / 任一 inflight / 切换：未选中 pending 字节不变、不投递
  // -------------------------------------------------------------------------

  it('无 active/在途/切换：未选中 pending 字节不变、不投递；选回来无新 activity 时恢复原义务', async () => {
    const h = makeHarness('delivery-selection-');
    const restore = failInboxWrites(h, 'before_commit');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    const pendingId = h.requests[0].delivery.id;
    const bytesBefore = fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8');

    // 在途（turn/retry/async task）→ 不读写交付
    for (const inflight of [
      { turnInFlight: true }, { retryInFlight: true }, { asyncTaskInFlight: true },
    ]) {
      await h.controller.observe({ ...stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1), ...inflight });
    }
    // 无 active → 不动作
    await h.controller.observe({
      activeContractId: undefined,
      lastActivityAt: 0,
      turnInFlight: false,
      retryInFlight: false,
      asyncTaskInFlight: false,
    });
    expect(h.requests).toHaveLength(1);
    expect(fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8')).toBe(bytesBefore);

    // 切到其他 contract：原 pending 字节不变；新 contract 建立自己的义务
    await h.controller.observe(stalled('other-contract', BASE_NOW - TIMEOUT_MS - 1));
    expect(fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8')).toBe(bytesBefore);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].contractId).toBe('other-contract');
    // （写仍失败，other-contract 也 pending——不干扰本契约义务）

    // 选回来且无新 activity：恢复原义务（同一 id），写恢复后确认
    restore();
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2].delivery.id).toBe(pendingId);
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: pendingId });
  });

  // -------------------------------------------------------------------------
  // Phase 1843: pending 未消费跨窗口不新增；消费后下一到期窗口恢复新增
  // -------------------------------------------------------------------------

  it('未消费跨 4 个窗口（含 controller 重建）：仍 1 消息、record 字节/attempt 不变，每窗口审计留证', async () => {
    const h = makeHarness('delivery-suppress-window-');
    const lastActivityAt = BASE_NOW - TIMEOUT_MS - 1;
    await h.controller.observe(stalled(CONTRACT_ID, lastActivityAt));
    const record1 = readRecord(h, CONTRACT_ID)!;
    expect(record1.attempts).toBe(1);
    expect(record1.delivery?.kind).toBe('confirmed');
    const recordBytes = fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8');
    const messageBytes = pendingFiles(h).map(f =>
      fs.readFileSync(path.join(h.pendingDir, f), 'utf8'));
    expect(messageBytes).toHaveLength(1);

    for (let w = 2; w <= 4; w++) {
      currentNow += TIMEOUT_MS;
      if (w === 3) reopen(h); // 跨重启行为相同
      await h.controller.observe(stalled(CONTRACT_ID, lastActivityAt));
      // 不生成新 ID/正文、不增加 attempt、不写新义务、不改消息文件
      expect(h.requests).toHaveLength(1);
      expect(fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8')).toBe(recordBytes);
      expect(pendingFiles(h).map(f => fs.readFileSync(path.join(h.pendingDir, f), 'utf8')))
        .toEqual(messageBytes);
      const hits = h.audit.entries.filter(e =>
        e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION &&
        e.some(col => String(col) === 'context=executionRecoveryPendingCheck') &&
        e.some(col => String(col) === 'reason=pending_reminder_exists') &&
        e.some(col => String(col) === `message_id=${record1.delivery!.id}`));
      expect(hits).toHaveLength(w - 1);
    }
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(1);
  });

  it('每窗口真实 drain+ack 后再进入下一窗口：四个不同 ID、累计 attempt4、done 四条（消费不等于契约完成）', async () => {
    const h = makeHarness('delivery-consume-window-');
    const lastActivityAt = BASE_NOW - TIMEOUT_MS - 1;
    const ids: string[] = [];
    for (let w = 1; w <= 4; w++) {
      await h.controller.observe(stalled(CONTRACT_ID, lastActivityAt));
      const record = readRecord(h, CONTRACT_ID)!;
      expect(record.attempts).toBe(w);
      expect(record.delivery?.kind).toBe('confirmed');
      ids.push(record.delivery!.id);
      expect(pendingFiles(h)).toHaveLength(1);
      // 真实消费链：drain → inflight → ack → done；不人为推进 activity
      const reader = createInboxReader(h.agentFs, h.audit, 'inbox');
      const batch = await reader.drainAndDeliver();
      expect(batch.kind).toBe('complete');
      if (batch.kind !== 'complete') throw new Error('unexpected batch kind');
      expect(batch.entries).toHaveLength(1);
      const msg = batch.entries[0].message;
      expect(msg.type).toBe('execution_recovery');
      expect(msg.from).toBe(CLAW_ID);
      expect(msg.priority).toBe('high');
      expect(msg.metadata?.contract_id).toBe(CONTRACT_ID);
      expect(msg.metadata?.[EXECUTION_RECOVERY_DELIVERY_META_KEY]).toBe(record.delivery!.id);
      await reader.ack(batch.handles[0]);
      expect(pendingFiles(h)).toHaveLength(0);
      currentNow += TIMEOUT_MS;
    }
    expect(new Set(ids).size).toBe(4);
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(4);
    expect(fs.readdirSync(path.join(h.agentDir, 'inbox', 'done'))).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // Phase 1843: 登记前 pending 查询故障——停止本次新增，正常 drain 语义不受影响
  // -------------------------------------------------------------------------

  it('登记前 pending 查询 list EIO：不建 record、0 消息、FATAL 审计携带原错误；恢复后可登记', async () => {
    const h = makeHarness('delivery-precheck-list-eio-');
    const restore = failPendingListEIO(h);
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(h, CONTRACT_ID)).toBeNull();
    expect(pendingFiles(h)).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    const fatal = h.audit.entries.find(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL &&
      e.some(col => String(col) === 'context=executionRecoveryPendingCheck'));
    expect(fatal).toBeDefined();
    expect(fatal!.some(col => String(col).includes('probe query EIO'))).toBe(true);

    // 恢复后重试检查：同窗口可正常登记
    restore();
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(1);
    expect(pendingFiles(h)).toHaveLength(1);
  });

  it('登记前 pending 查询 read EIO：既有 record 原字节不变、0 新消息；坏消息恢复后可登记', async () => {
    const h = makeHarness('delivery-precheck-read-eio-');
    const existing: ExecutionRecoveryRecord = {
      schema_version: 1,
      contractId: CONTRACT_ID,
      observedActivityAt: BASE_NOW - TIMEOUT_MS - 1,
      attempts: 2,
      lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
    };
    h.store.save(existing);
    const bytesBefore = fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8');
    // 无关坏消息（非本契约类型）也使本次新增查询未知——peek 是全目录解码
    await writeInboxAsync(h.agentFs, h.pendingDir, {
      id: 'unrelated-1',
      type: 'task',
      from: 'motion',
      to: '',
      priority: 'normal',
      content: 'unrelated',
      timestamp: new Date(BASE_NOW).toISOString(),
    }, h.audit);
    const restore = failPendingReadEIO(h);
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8')).toBe(bytesBefore);
    expect(pendingFiles(h)).toHaveLength(1); // 只有预置坏消息，无新增
    expect(h.requests).toHaveLength(0);
    const fatal = h.audit.entries.find(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL &&
      e.some(col => String(col) === 'context=executionRecoveryPendingCheck'));
    expect(fatal).toBeDefined();
    // Phase 1869 (Step C): 未结算查询（peekUnsettled）读取失败原样抛出原 error
    // （不再包装为 PendingViewError 文案）；未知仍显式留证、不折 absent。
    expect(fatal!.some(col => String(col).includes('probe read EIO'))).toBe(true);

    // 坏消息恢复可读后：无关消息不匹配三要素，正常登记 attempt3
    restore();
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(readRecord(h, CONTRACT_ID)?.attempts).toBe(3);
    expect(pendingFiles(h)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // writeInboxAsync 直写 owner 侧证据（手工预置消息 = 真实 owner API 写入）
  // -------------------------------------------------------------------------

  it('消息已在 inflight 时重建 controller：预查询命中即确认，不重复写（真实 owner 写 + drain 预置）', async () => {
    const h = makeHarness('delivery-preexisting-');
    // 先建立 pending 义务但写失败（0 消息）
    const restore = failInboxWrites(h, 'before_commit');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    restore();
    const delivery = h.requests[0].delivery;

    // 真实 owner API 写入同身份消息并 drain 到 inflight（外部已投递的场景）
    await writeInboxAsync(h.agentFs, h.pendingDir, {
      id: delivery.id,
      type: 'execution_recovery',
      from: CLAW_ID,
      to: '',
      priority: 'high',
      content: delivery.body,
      timestamp: new Date(delivery.scheduledAt).toISOString(),
      metadata: { contract_id: CONTRACT_ID, [EXECUTION_RECOVERY_DELIVERY_META_KEY]: delivery.id },
    }, h.audit);
    const reader = createInboxReader(h.agentFs, h.audit, 'inbox');
    const batch = await reader.drainAndDeliver();
    expect(batch.kind).toBe('complete');

    reopen(h);
    const writeSpy = vi.spyOn(h.agentFs, 'writeAtomic');
    await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW - TIMEOUT_MS - 1));
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readRecord(h, CONTRACT_ID)?.delivery).toMatchObject({ kind: 'confirmed', id: delivery.id });
  });

  // -------------------------------------------------------------------------
  // Phase 1843: pending 精确匹配矩阵（真实 owner 写 + 真实 _findPendingExecutionResume 链）
  // -------------------------------------------------------------------------

  describe('pending 精确匹配矩阵（Phase 1843）', () => {
    const LAST_ACTIVITY_AT = BASE_NOW - TIMEOUT_MS - 1;

    /** 真实 owner API 预置消息（旧格式可缺 1842 delivery 关联字段）。 */
    async function writeReminder(h: Harness, opts: {
      id: string;
      contractId: string;
      from?: string;
      type?: string;
      withDeliveryMeta?: boolean;
    }): Promise<void> {
      await writeInboxAsync(h.agentFs, h.pendingDir, {
        id: opts.id,
        type: opts.type ?? 'execution_recovery',
        from: opts.from ?? CLAW_ID,
        to: '',
        priority: 'high',
        content: `old reminder ${opts.id}`,
        // 旧消息年龄不影响匹配
        timestamp: new Date(BASE_NOW - 100 * TIMEOUT_MS).toISOString(),
        metadata: {
          contract_id: opts.contractId,
          ...(opts.withDeliveryMeta ? { [EXECUTION_RECOVERY_DELIVERY_META_KEY]: opts.id } : {}),
        },
      }, h.audit);
    }

    function pendingSnapshot(h: Harness): string[] {
      return pendingFiles(h).sort().map(f => fs.readFileSync(path.join(h.pendingDir, f), 'utf8'));
    }

    function expectSuppressed(h: Harness, messageId: string, count?: number): void {
      expect(h.requests).toHaveLength(0);
      const hit = h.audit.entries.find(e =>
        e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION &&
        e.some(col => String(col) === 'context=executionRecoveryPendingCheck') &&
        e.some(col => String(col) === 'reason=pending_reminder_exists'));
      expect(hit).toBeDefined();
      expect(hit!.some(col => String(col) === `message_id=${messageId}`)).toBe(true);
      if (count !== undefined) {
        // Phase 1869 (Step C): 未结算命中总数（pending + inflight）入审计。
        expect(hit!.some(col => String(col) === `count=${count}`)).toBe(true);
      }
    }

    it('旧格式消息（无 1842 delivery 关联字段）+ 无 record：抑制新增、不建 record、消息字节不变', async () => {
      const h = makeHarness('matrix-legacy-norecord-');
      await writeReminder(h, { id: 'old-reminder', contractId: CONTRACT_ID });
      const before = pendingSnapshot(h);
      await h.controller.observe(stalled(CONTRACT_ID, LAST_ACTIVITY_AT));
      expectSuppressed(h, 'old-reminder');
      expect(readRecord(h, CONTRACT_ID)).toBeNull();
      expect(pendingSnapshot(h)).toEqual(before);
    });

    it('旧格式消息 + 旧 confirmed record：抑制新增、record 字节不变', async () => {
      const h = makeHarness('matrix-legacy-confirmed-');
      h.store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: LAST_ACTIVITY_AT,
        attempts: 1,
        lastAttemptAt: BASE_NOW - 20 * TIMEOUT_MS,
        delivery: {
          kind: 'confirmed',
          id: 'execution_recovery-old',
          attempt: 1,
          scheduledAt: BASE_NOW - 20 * TIMEOUT_MS,
          body: 'old body',
          confirmedAt: BASE_NOW - 19 * TIMEOUT_MS,
        },
      });
      await writeReminder(h, { id: 'old-reminder', contractId: CONTRACT_ID });
      const recordBytes = fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8');
      const before = pendingSnapshot(h);
      await h.controller.observe(stalled(CONTRACT_ID, LAST_ACTIVITY_AT));
      expectSuppressed(h, 'old-reminder');
      expect(fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8')).toBe(recordBytes);
      expect(pendingSnapshot(h)).toEqual(before);
    });

    it('旧格式消息 + 旧无 delivery record：抑制新增、record 字节不变', async () => {
      const h = makeHarness('matrix-legacy-nodelivery-');
      h.store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: LAST_ACTIVITY_AT,
        attempts: 2,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
      });
      await writeReminder(h, { id: 'old-reminder', contractId: CONTRACT_ID });
      const recordBytes = fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8');
      await h.controller.observe(stalled(CONTRACT_ID, LAST_ACTIVITY_AT));
      expectSuppressed(h, 'old-reminder');
      expect(fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8')).toBe(recordBytes);
    });

    it('同契约旧 epoch 两条积压（不只匹配最新 delivery ID）：不生成第三条、原文件不删改', async () => {
      const h = makeHarness('matrix-old-epoch-');
      await writeReminder(h, { id: 'epoch-1', contractId: CONTRACT_ID, withDeliveryMeta: true });
      await writeReminder(h, { id: 'epoch-2', contractId: CONTRACT_ID });
      const before = pendingSnapshot(h);
      await h.controller.observe(stalled(CONTRACT_ID, LAST_ACTIVITY_AT));
      expect(h.requests).toHaveLength(0);
      expect(readRecord(h, CONTRACT_ID)).toBeNull();
      expect(pendingSnapshot(h)).toEqual(before);
      const hit = h.audit.entries.find(e =>
        e.some(col => String(col) === 'reason=pending_reminder_exists'));
      expect(hit).toBeDefined();
      // 命中证据是 reader 排序后首个现存 ID（两条之一），不枚举/删除旧消息
      expect(['message_id=epoch-1', 'message_id=epoch-2']
        .some(col => hit!.some(c => String(c) === col))).toBe(true);
      // Phase 1869 (Step C): 两条未结算事实全部计入 count。
      expect(hit!.some(c => String(c) === 'count=2')).toBe(true);
    });

    it('inflight 残留（degraded reconcile 形态）同样构成抑制事实（phase 1869 Step C）', async () => {
      const h = makeHarness('matrix-inflight-');
      await writeReminder(h, { id: 'inflight-reminder', contractId: CONTRACT_ID });
      // 真实 owner 链：drain claim 到 inflight、不 ack——模拟未结算残留
      const reader = createInboxReader(h.agentFs, h.audit, path.dirname(h.pendingDir));
      const drained = await reader.drainAndDeliver();
      expect(drained.kind).toBe('complete');
      expect(pendingFiles(h)).toHaveLength(0);

      await h.controller.observe(stalled(CONTRACT_ID, LAST_ACTIVITY_AT));
      expectSuppressed(h, 'inflight-reminder', 1);
      expect(readRecord(h, CONTRACT_ID)).toBeNull();
    });

    it('三要素缺一不抑制：同 contract 不同 type / 同 type 不同 from / 同 type from 不同 contract', async () => {
      // 同 contract 不同 type
      const h1 = makeHarness('matrix-diff-type-');
      await writeReminder(h1, { id: 'm-type', contractId: CONTRACT_ID, type: 'task' });
      await h1.controller.observe(stalled(CONTRACT_ID, LAST_ACTIVITY_AT));
      expect(h1.requests).toHaveLength(1);
      expect(readRecord(h1, CONTRACT_ID)?.attempts).toBe(1);
      expect(pendingFiles(h1)).toHaveLength(2);

      // 同 type 不同 from
      const h2 = makeHarness('matrix-diff-from-');
      await writeReminder(h2, { id: 'm-from', contractId: CONTRACT_ID, from: 'claw-2' });
      await h2.controller.observe(stalled(CONTRACT_ID, LAST_ACTIVITY_AT));
      expect(h2.requests).toHaveLength(1);
      expect(pendingFiles(h2)).toHaveLength(2);

      // 同 type/from 不同 contract（选中 CONTRACT_ID，队列里只有 other-contract 提醒）
      const h3 = makeHarness('matrix-diff-contract-');
      await writeReminder(h3, { id: 'm-contract', contractId: 'other-contract' });
      await h3.controller.observe(stalled(CONTRACT_ID, LAST_ACTIVITY_AT));
      expect(h3.requests).toHaveLength(1);
      expect(pendingFiles(h3)).toHaveLength(2);
    });

    it('新 activity：reset 合法写仍落盘；新 epoch 到期时被旧 pending 提醒抑制', async () => {
      const h = makeHarness('matrix-activity-reset-');
      h.store.save({
        schema_version: 1,
        contractId: CONTRACT_ID,
        observedActivityAt: BASE_NOW - 10 * TIMEOUT_MS,
        attempts: 1,
        lastAttemptAt: BASE_NOW - 10 * TIMEOUT_MS,
        delivery: {
          kind: 'confirmed',
          id: 'execution_recovery-old',
          attempt: 1,
          scheduledAt: BASE_NOW - 10 * TIMEOUT_MS,
          body: 'old body',
          confirmedAt: BASE_NOW - 10 * TIMEOUT_MS,
        },
      });
      await writeReminder(h, { id: 'old-reminder', contractId: CONTRACT_ID });

      // activity 前进：先持久化零计数 reset（合法写，不被「抑制不写状态」阻断）
      await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW));
      const reset = readRecord(h, CONTRACT_ID)!;
      expect(reset).toMatchObject({ attempts: 0, lastAttemptAt: 0, observedActivityAt: BASE_NOW });
      expect(h.audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET)).toBe(true);
      expect(h.requests).toHaveLength(0);
      const resetBytes = fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8');

      // 新 epoch 到期：旧提醒仍 pending → 抑制新增，reset 记录字节不变
      currentNow += TIMEOUT_MS;
      await h.controller.observe(stalled(CONTRACT_ID, BASE_NOW));
      expectSuppressed(h, 'old-reminder');
      expect(fs.readFileSync(recordPath(h, CONTRACT_ID), 'utf8')).toBe(resetBytes);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 1845: 旧英文正文 pending 义务原样补投——冻结 body 不重写为新正文
  // -------------------------------------------------------------------------

  it('旧英文正文 pending 义务（phase 1845 前落盘）：原样补投并 confirmed，id/attempt/scheduledAt/body 不变、不加次', async () => {
    const h = makeHarness('delivery-legacy-body-');
    // phase 1845 之前的旧正文 literal（含调度次数措辞）；用真实 store.save 预置
    // 合法 pending 义务，不 mock 模板制造旧 body。
    const LEGACY_BODY =
      `Execution stalled with no persisted activity; resume work on active contract ${CONTRACT_ID} (recovery attempt 1).`;
    const observedActivityAt = BASE_NOW - 2 * TIMEOUT_MS;
    const scheduledAt = BASE_NOW - TIMEOUT_MS - 1;
    h.store.save({
      schema_version: 1,
      contractId: CONTRACT_ID,
      observedActivityAt,
      attempts: 1,
      lastAttemptAt: scheduledAt,
      delivery: {
        kind: 'pending',
        id: 'execution_recovery-legacy-body',
        attempt: 1,
        scheduledAt,
        body: LEGACY_BODY,
      },
    });

    // snapshot.lastActivityAt 与 record.observedActivityAt 相等（无新 activity）且
    // 三个 inFlight=false → 真实 observe 直接补投该冻结义务
    await h.controller.observe(stalled(CONTRACT_ID, observedActivityAt));

    // 补投同一冻结义务：不重新渲染模板、不增加 attempt、不登记新义务
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].delivery).toEqual({
      kind: 'pending',
      id: 'execution_recovery-legacy-body',
      attempt: 1,
      scheduledAt,
      body: LEGACY_BODY,
    });
    // 消息正文原样为旧英文冻结 body（不重写为新正文）
    const messages = readPendingMessages(h);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('execution_recovery-legacy-body');
    expect(messages[0].content).toBe(LEGACY_BODY);
    expect(messages[0].metadata?.contract_id).toBe(CONTRACT_ID);
    expect(messages[0].metadata?.[EXECUTION_RECOVERY_DELIVERY_META_KEY]).toBe('execution_recovery-legacy-body');
    // record 原字段保留，仅 kind 转 confirmed（confirmedAt=当前时刻）
    const record = readRecord(h, CONTRACT_ID)!;
    expect(record.attempts).toBe(1);
    expect(record.observedActivityAt).toBe(observedActivityAt);
    expect(record.lastAttemptAt).toBe(scheduledAt);
    expect(record.delivery).toEqual({
      kind: 'confirmed',
      id: 'execution_recovery-legacy-body',
      attempt: 1,
      scheduledAt,
      body: LEGACY_BODY,
      confirmedAt: BASE_NOW,
    });
  });
});
