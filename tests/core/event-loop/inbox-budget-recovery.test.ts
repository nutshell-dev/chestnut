/**
 * Phase 1967 Step C: inbox 预算/defer/恢复矩阵（真实 EventLoop/Runtime/Messaging 链）。
 *
 * 锁定 1940 D3/D4/D6 与 1939 flood 目标：
 * - 85 条洪峰：单轮注入 ≤20 条且格式化字节 ≤64KiB；deferred 回 pending 不被
 *   结算/计数；success 后逐轮轮转直至清空；无重复交付；
 * - 连续 LLM failure：每轮注入有界且不增长；selected 按失败 nack（attempts 递增
 *   属失败语义）；deferred 保持 pending 且 delivery_attempts 不变；
 * - abort（format 后、processTurn 前 stop）：selected 全 nack，deferred 已安全
 *   回 pending，零 ack；
 * - 崩溃/重启（claim 后 ack 前）：reconcile 回 pending，原消息逐条最终交付一次；
 * - oversized 单条：显式单独放行 + runtime_inbox_oversized_alone 审计，正文
 *   逐字节不变，后续消息下一轮继续；
 * - no early ack：processTurn resolve 前 ack 0 次；defer 在 processTurn 前完成。
 *
 * 只加测试，不改生产行为。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Runtime } from '../../../src/core/runtime/index.js';
import type { FormattedInboxBatch, PreparedInboxBatch } from '../../../src/core/runtime/index.js';
import {
  INBOX_BATCH_MAX_ITEMS,
  INBOX_BATCH_MAX_FORMATTED_BYTES,
  formattedMessageBytes,
  type InboxFormatBudget,
} from '../../../src/core/runtime/inbox-budget.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { createTestEventLoop } from '../../helpers/test-event-loop.js';
import { createMockLLMConfig } from '../_runtime-test-helpers.js';
import {
  writeInboxAsync,
  decodeInbox,
  InboxWriter,
  makeInboxPath,
  INBOX_PENDING_DIR,
  type InboxMessage,
} from '../../../src/foundation/messaging/index.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { EventLoop } from '../../../src/core/event-loop/index.js';

// 失败/中断调度退避小值化（对齐 processbatch-orchestrator 测试惯例）
vi.mock('../../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/event-loop/constants.js')>('../../../src/core/event-loop/constants.js');
  return {
    ...actual,
    UNKNOWN_ERROR_RECOVERY_DELAY_MS: 10,
    INTERRUPT_RECOVERY_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_MAX_DELAY_MS: 50,
  };
});

const CLAW_ID = 'budget-claw';

function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

/** 真实 Runtime + 可控 _runReact / format 观察钩子（不复制控制逻辑）。 */
class BudgetTestRuntime extends Runtime {
  public formatCalls: FormattedInboxBatch[] = [];
  public onRunReact?: (messages: Message[], turnIndex: number) => Promise<void> | void;
  public afterFormat?: () => void;
  private turnIndex = 0;

  override async formatPreparedInbox(
    batch: PreparedInboxBatch,
    budget?: InboxFormatBudget,
  ): Promise<FormattedInboxBatch> {
    const result = await super.formatPreparedInbox(batch, budget);
    this.formatCalls.push(result);
    this.afterFormat?.();
    return result;
  }

  protected override async _runReact(messages: Message[]): Promise<void> {
    const idx = this.turnIndex++;
    await this.onRunReact?.(messages, idx);
  }
}

describe('inbox budget recovery matrix (Phase 1967 Step C)', () => {
  let testTempDir: string;
  let testClawDir: string;
  const runtimes: Runtime[] = [];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testTempDir = path.join(tmpdir(), `chestnut-inbox-budget-${randomUUID()}`);
    testClawDir = path.join(testTempDir, 'claws', CLAW_ID);
    await fsp.mkdir(testClawDir, { recursive: true });
  });

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => { /* silent: shutdown */ });
    }
    await fsp.rm(testTempDir, { recursive: true, force: true }).catch(() => { /* silent */ });
    vi.restoreAllMocks();
  });

  function pendingDir(): string {
    return path.join(testClawDir, 'inbox', 'pending');
  }
  function doneDir(): string {
    return path.join(testClawDir, 'inbox', 'done');
  }
  async function listMd(dir: string): Promise<string[]> {
    try {
      return (await fsp.readdir(dir)).filter(n => n.endsWith('.md')).sort();
    } catch {
      return [];
    }
  }
  async function pendingRawByName(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const name of await listMd(pendingDir())) {
      map.set(name, await fsp.readFile(path.join(pendingDir(), name), 'utf8'));
    }
    return map;
  }
  async function pendingMessages(): Promise<InboxMessage[]> {
    return [...(await pendingRawByName()).values()].map(raw => decodeInbox(raw));
  }

  function makeSeedMessage(i: number, opts: Partial<InboxMessage> = {}): InboxMessage {
    return {
      id: `msg-${String(i).padStart(3, '0')}`,
      type: 'user_chat',
      from: 'user',
      to: CLAW_ID,
      content: `flood body ${i}`,
      priority: opts.priority ?? 'normal',
      // 稳定 age 序：i 小者先
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      metadata: { idempotency_key: `idem-${i}` },
      ...opts,
    };
  }

  async function makeHarness(opts: { seedCount: number; seedOpts?: (i: number) => Partial<InboxMessage> }) {
    const audit = createMockAudit();
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: CLAW_ID, auditOverride: audit });
    for (let i = 0; i < opts.seedCount; i++) {
      await writeInboxAsync(deps.systemFs, INBOX_PENDING_DIR, makeSeedMessage(i, opts.seedOpts?.(i)), audit);
    }
    const runtime = new BudgetTestRuntime({
      clawId: CLAW_ID,
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    const loop = createTestEventLoop({ runtime, clawDir: testClawDir, clawId: CLAW_ID });
    return { audit, deps, runtime, loop };
  }

  it('85 条洪峰 success：单轮 ≤20 条/≤64KiB，逐轮轮转清空，无重复交付', { timeout: 60_000 }, async () => {
    const { runtime, loop } = await makeHarness({
      seedCount: 85,
      // 5 条 critical（最新 timestamp）验证 priority 先于 age
      seedOpts: i => (i < 5 ? { priority: 'critical' as const } : {}),
    });

    await loop.run();

    // 5 轮：20+20+20+20+5
    expect(runtime.formatCalls.map(c => c.selected.length)).toEqual([20, 20, 20, 20, 5]);
    for (const call of runtime.formatCalls) {
      expect(call.selected.length).toBeLessThanOrEqual(INBOX_BATCH_MAX_ITEMS);
      const bytes = call.injected.map(m => formattedMessageBytes(m)).reduce((a, b) => a + b, 0);
      expect(bytes).toBeLessThanOrEqual(INBOX_BATCH_MAX_FORMATTED_BYTES);
      expect(call.count).toBe(call.selected.length);
      expect(call.oversizedAlone).toBe(false);
    }
    // 首轮含全部 5 条 critical（priority 先于 age）
    const firstRoundIds = new Set(runtime.formatCalls[0].selected.map(e => e.message.id));
    for (let i = 0; i < 5; i++) {
      expect(firstRoundIds.has(`msg-${String(i).padStart(3, '0')}`)).toBe(true);
    }
    // 逐消息守恒：85 条各交付恰好一次
    const deliveredIds = runtime.formatCalls.flatMap(c => c.selected.map(e => e.message.id));
    expect(deliveredIds).toHaveLength(85);
    expect(new Set(deliveredIds).size).toBe(85);
    // 全 ack：done=85，pending 空
    expect(await listMd(doneDir())).toHaveLength(85);
    expect(await listMd(pendingDir())).toHaveLength(0);
  });

  it('defer 语义：deferred 回 pending 且 delivery_attempts 不变、原文逐字节不变；processTurn resolve 前零 ack', { timeout: 60_000 }, async () => {
    const { deps, runtime, loop } = await makeHarness({ seedCount: 25 });
    const preRunRaw = await pendingRawByName();
    expect(preRunRaw.size).toBe(25);
    const ackSpy = vi.spyOn(deps.inboxReader, 'ack');
    const deferSpy = vi.spyOn(deps.inboxReader, 'defer');

    // no-early-ack 观察点：首个 turn 执行期间
    let observedDuringFirstTurn: { ackCalls: number; pending: Map<string, string> } | undefined;
    runtime.onRunReact = async (_messages, turnIndex) => {
      if (turnIndex !== 0) return;
      observedDuringFirstTurn = {
        ackCalls: ackSpy.mock.calls.length,
        pending: await pendingRawByName(),
      };
    };

    await loop.run();

    // 首轮 20 selected + 5 deferred；defer 在 processTurn 前完成
    expect(runtime.formatCalls[0].selected).toHaveLength(20);
    expect(runtime.formatCalls[0].deferred).toHaveLength(5);
    expect(deferSpy).toHaveBeenCalledTimes(5);
    expect(deferSpy.mock.calls.every(c => c[1] === 'budget_deferred')).toBe(true);
    // processTurn resolve 前 ack 0 次
    expect(observedDuringFirstTurn).toBeDefined();
    expect(observedDuringFirstTurn!.ackCalls).toBe(0);
    // turn 执行期间 deferred 已回 pending（5 条），内容逐字节不变、无 delivery_attempts
    expect(observedDuringFirstTurn!.pending.size).toBe(5);
    for (const [name, raw] of observedDuringFirstTurn!.pending) {
      expect(raw).toBe(preRunRaw.get(name));
      expect(decodeInbox(raw).metadata?.delivery_attempts).toBeUndefined();
    }
    // 链式轮转终态：25 条全部恰好一次交付 + ack
    const deliveredIds = runtime.formatCalls.flatMap(c => c.selected.map(e => e.message.id));
    expect(new Set(deliveredIds).size).toBe(25);
    expect(ackSpy).toHaveBeenCalledTimes(25);
    expect(await listMd(doneDir())).toHaveLength(25);
  });

  it('连续 LLM failure：每轮注入有界不增长；selected 按失败 nack 计数；deferred 不计数；恢复后继续轮转', { timeout: 60_000 }, async () => {
    const { runtime, loop } = await makeHarness({ seedCount: 25 });
    let fail = true;
    runtime.onRunReact = () => {
      if (fail) throw new Error('llm boom');
    };

    await loop.run(); // 第 1 轮失败：20 nack，5 deferred
    await loop.run(); // 第 2 轮失败：同 20 再 nack（age 序稳定）

    // 每轮注入有界且不增长
    expect(runtime.formatCalls.map(c => c.selected.length)).toEqual([20, 20]);
    // 失败语义：selected 20 条 attempts=2（两轮失败）；deferred 5 条不计数
    const pending = await pendingMessages();
    expect(pending).toHaveLength(25);
    const attempts = new Map(pending.map(m => [m.id, m.metadata?.delivery_attempts]));
    const firstTwenty = runtime.formatCalls[0].selected.map(e => e.message.id);
    for (const id of firstTwenty) expect(attempts.get(id)).toBe('2');
    for (const e of runtime.formatCalls[0].deferred) {
      expect(attempts.get(e.message.id)).toBeUndefined();
    }
    expect(await listMd(doneDir())).toHaveLength(0);

    // 恢复后继续轮转：25 条全部恰好一次成功交付
    fail = false;
    await loop.run();
    const successIds = runtime.formatCalls.slice(2).flatMap(c => c.selected.map(e => e.message.id));
    expect(new Set(successIds).size).toBe(25);
    expect(await listMd(doneDir())).toHaveLength(25);
    expect(await listMd(pendingDir())).toHaveLength(0);
  });

  it('abort（format 后、processTurn 前 stop）：selected 全 nack、deferred 保持 pending、零 ack', { timeout: 60_000 }, async () => {
    const { deps, runtime, loop } = await makeHarness({ seedCount: 25 });
    const ackSpy = vi.spyOn(deps.inboxReader, 'ack');
    const nackSpy = vi.spyOn(deps.inboxReader, 'nack');
    const preRunRaw = await pendingRawByName();
    runtime.afterFormat = () => loop.abort();

    await loop.run();

    expect(runtime.formatCalls).toHaveLength(1);
    expect(runtime.formatCalls[0].selected).toHaveLength(20);
    expect(runtime.formatCalls[0].deferred).toHaveLength(5);
    // selected 20 全 nack（interrupted_before_injection），零 ack
    expect(ackSpy).not.toHaveBeenCalled();
    expect(nackSpy).toHaveBeenCalledTimes(20);
    expect(nackSpy.mock.calls.every(c => c[1] === 'interrupted_before_injection')).toBe(true);
    // 全部 25 条回 pending；deferred 5 条原文逐字节不变、不计数
    const postRaw = await pendingRawByName();
    expect(postRaw.size).toBe(25);
    const deferredNames = new Set(runtime.formatCalls[0].deferred.map(e => e.handle.originalFileName));
    for (const name of deferredNames) {
      expect(postRaw.get(name)).toBe(preRunRaw.get(name));
      expect(decodeInbox(postRaw.get(name)!).metadata?.delivery_attempts).toBeUndefined();
    }
    expect(await listMd(doneDir())).toHaveLength(0);
  });

  it('崩溃/重启（claim 后 ack 前）：reconcile 回 pending，原消息逐条最终交付一次', { timeout: 60_000 }, async () => {
    const { deps, runtime } = await makeHarness({ seedCount: 3 });
    void runtime;
    // 模拟崩溃窗：claim 到 inflight 后进程消失（无 ack/nack/defer）
    const drain = await deps.inboxReader.drainAndDeliver();
    expect(drain.kind).toBe('complete');
    expect(drain.entries).toHaveLength(3);
    expect(await listMd(pendingDir())).toHaveLength(0);
    // 记录崩溃现场（按消息 id 键控：claim 文件名含 pid 租约前缀）
    const inflightDir = path.join(testClawDir, 'inbox', 'inflight');
    const crashedRawById = new Map<string, string>();
    for (const name of await listMd(inflightDir)) {
      const raw = await fsp.readFile(path.join(inflightDir, name), 'utf8');
      crashedRawById.set(decodeInbox(raw).id, raw);
    }
    expect(crashedRawById.size).toBe(3);
    // 崩溃证据：claim 租约 owner 进程已死（重写 pid 为不存在进程，保留原租约其余部分）
    for (const name of await listMd(inflightDir)) {
      const deadName = name.replace(/^\d+_/, '999999_');
      await fsp.rename(path.join(inflightDir, name), path.join(inflightDir, deadName));
    }

    // 重启：新 Runtime/reader，initialize 的 startup reconcile 把 inflight 回 pending
    const audit2 = createMockAudit();
    const deps2 = await makeRuntimeDeps({ clawDir: testClawDir, clawId: CLAW_ID, auditOverride: audit2 });
    const runtime2 = new BudgetTestRuntime({
      clawId: CLAW_ID,
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps2,
    });
    runtimes.push(runtime2);
    await runtime2.initialize();
    const rebootRaw = await pendingRawByName();
    expect(rebootRaw.size).toBe(3);
    // reconcile 不改写原文、不计 delivery_attempts
    for (const raw of rebootRaw.values()) {
      const id = decodeInbox(raw).id;
      expect(raw).toBe(crashedRawById.get(id));
      expect(decodeInbox(raw).metadata?.delivery_attempts).toBeUndefined();
    }

    const loop2 = createTestEventLoop({ runtime: runtime2, clawDir: testClawDir, clawId: CLAW_ID });
    await loop2.run();

    // 逐条最终交付恰好一次
    const deliveredIds = runtime2.formatCalls.flatMap(c => c.selected.map(e => e.message.id));
    expect(deliveredIds.sort()).toEqual(['msg-000', 'msg-001', 'msg-002']);
    expect(await listMd(doneDir())).toHaveLength(3);
    expect(await listMd(pendingDir())).toHaveLength(0);
  });

  it('oversized 单条：显式单独放行 + 审计，正文逐字节不变；后续消息下一轮继续', { timeout: 60_000 }, async () => {
    const audit = createMockAudit();
    const deps = await makeRuntimeDeps({ clawDir: testClawDir, clawId: CLAW_ID, auditOverride: audit });
    // 超 64KiB 格式化预算的单条：绕过默认写 cap（模拟 cap 调大/历史遗留的大消息）
    const bigContent = 'x'.repeat(100 * 1024);
    const writer = InboxWriter.__internal_create(
      deps.systemFs, makeInboxPath(INBOX_PENDING_DIR), audit, { bodyMaxBytes: 1024 * 1024 },
    );
    await writer.write(makeSeedMessage(0, { content: bigContent }));
    await writeInboxAsync(deps.systemFs, INBOX_PENDING_DIR, makeSeedMessage(1), audit);
    await writeInboxAsync(deps.systemFs, INBOX_PENDING_DIR, makeSeedMessage(2), audit);

    const runtime = new BudgetTestRuntime({
      clawId: CLAW_ID,
      clawDir: testClawDir,
      llmConfig: createMockLLMConfig(),
      dependencies: deps,
    });
    runtimes.push(runtime);
    await runtime.initialize();
    const loop = createTestEventLoop({ runtime, clawDir: testClawDir, clawId: CLAW_ID });

    await loop.run();

    // 第 1 轮：oversized 单独放行；第 2 轮：剩余 2 条
    expect(runtime.formatCalls).toHaveLength(2);
    const first = runtime.formatCalls[0];
    expect(first.oversizedAlone).toBe(true);
    expect(first.selected.map(e => e.message.id)).toEqual(['msg-000']);
    expect(first.deferred.map(e => e.message.id).sort()).toEqual(['msg-001', 'msg-002']);
    // 不截断/不摘要：正文逐字节不变
    expect(first.injected[0].content).toContain(bigContent);
    expect(formattedMessageBytes(first.injected[0])).toBeGreaterThan(INBOX_BATCH_MAX_FORMATTED_BYTES);
    // 审计：runtime_inbox_oversized_alone 带 file/bytes/budget_bytes
    const oversizedRow = audit.entries.find(e => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_OVERSIZED_ALONE);
    expect(oversizedRow).toBeDefined();
    expect(oversizedRow!.some(c => typeof c === 'string' && c.startsWith('bytes='))).toBe(true);
    expect(oversizedRow).toContain(`budget_bytes=${INBOX_BATCH_MAX_FORMATTED_BYTES}`);
    // 第 2 轮：剩余 2 条正常交付
    expect(runtime.formatCalls[1].selected.map(e => e.message.id).sort()).toEqual(['msg-001', 'msg-002']);
    expect(await listMd(doneDir())).toHaveLength(3);
    expect(await listMd(pendingDir())).toHaveLength(0);
  });

  it('defer 失败：回队 selected+失败句柄并中止本轮，不误 ack', { timeout: 60_000 }, async () => {
    const { deps, runtime, loop } = await makeHarness({ seedCount: 25 });
    const ackSpy = vi.spyOn(deps.inboxReader, 'ack');
    const nackSpy = vi.spyOn(deps.inboxReader, 'nack');
    // 注入 defer 故障（Fs 边界：defer 整体拒绝）
    vi.spyOn(deps.inboxReader, 'defer').mockRejectedValue(new Error('defer io boom'));
    let turns = 0;
    runtime.onRunReact = () => { turns++; };

    await loop.run();

    // 中止本轮：processTurn 零调用、零 ack；25 条全部回 pending
    expect(turns).toBe(0);
    expect(ackSpy).not.toHaveBeenCalled();
    expect(runtime.formatCalls).toHaveLength(1);
    expect(nackSpy).toHaveBeenCalledTimes(25);
    expect(nackSpy.mock.calls.every(c => c[1] === 'budget_defer_failed')).toBe(true);
    expect((await pendingMessages())).toHaveLength(25);
    expect(await listMd(doneDir())).toHaveLength(0);
  });
});
