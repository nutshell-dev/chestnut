/**
 * Phase 1967 Step B: inbox 注入预算/轮转/oversized 单测。
 *
 * 锁定：
 * - orderInboxEntries 稳定 priority→age 排序（同 priority/timestamp 保原顺序）；
 * - 预算按最终格式化表示（注入 Message 的 JSON 字节）计量，非原始正文；
 * - 条数/字节双预算：未选消息进 deferred（不格式化到注入、不发 INBOX_INJECT）；
 * - 单条超预算消息显式单独放行 + runtime_inbox_oversized_alone 审计，
 *   不截断/不摘要，后续消息全部 deferred；
 * - 默认预算 20 条 / 64KiB（1939 拍板）对 85 条洪峰有界。
 */

import { describe, it, expect, vi } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import {
  INBOX_BATCH_MAX_ITEMS,
  INBOX_BATCH_MAX_FORMATTED_BYTES,
  DEFAULT_INBOX_FORMAT_BUDGET,
  orderInboxEntries,
  formattedMessageBytes,
} from '../../../src/core/runtime/inbox-budget.js';
import {
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
  MESSAGING_INBOX_MESSAGE_TYPES,
} from '../../../src/foundation/messaging/index.js';
import { GATEWAY_INBOX_MESSAGE_TYPES } from '../../../src/core/gateway/index.js';
import type { InboxMessage, InboxHandle } from '../../../src/foundation/messaging/index.js';
import type { PreparedInboxEntry } from '../../../src/core/runtime/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

function buildRuntime(audit: AuditLog): Runtime {
  const registry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(registry, MESSAGING_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(registry, GATEWAY_INBOX_MESSAGE_TYPES);
  return new Runtime({
    clawId: 'test-claw',
    clawDir: '/tmp/test-claw',
    idleTimeoutMs: 0,
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    } as never,
    dependencies: {
      systemFs: {} as never,
      auditWriter: audit,
      snapshot: {} as never,
      sessionManager: {} as never,
      inboxReader: {} as never,
      llm: {} as never,
      llmOrchestrator: {} as never,
      toolRegistry: {} as never,
      toolExecutor: {} as never,
      contractManager: {} as never,
      taskSystem: {} as never,
      skillRegistry: {} as never,
      permissionChecker: {} as never,
      fsFactory: () => ({} as never),
      dialogStoreFactory: vi.fn(),
      formatterRegistry: registry,
    },
  } as never);
}

function entry(
  id: string,
  opts: { priority?: InboxMessage['priority']; timestamp?: string; content?: string } = {},
): PreparedInboxEntry {
  const message: InboxMessage = {
    id,
    type: 'user_chat',
    from: 'user',
    to: 'test-claw',
    content: opts.content ?? `body-${id}`,
    priority: opts.priority ?? 'normal',
    timestamp: opts.timestamp ?? '2026-10-21T00:00:00.000Z',
  };
  return { message, handle: { filePath: `inflight/${id}.md`, originalFileName: `${id}.md` } as InboxHandle };
}

describe('inbox-budget: orderInboxEntries (Phase 1967 Step B)', () => {
  it('critical→high→normal→low；同 priority 按 timestamp 升序；完全同键保原顺序（stable）', () => {
    const entries = [
      entry('low-1', { priority: 'low', timestamp: '2026-10-21T00:00:01.000Z' }),
      entry('normal-new', { priority: 'normal', timestamp: '2026-10-21T00:00:02.000Z' }),
      entry('critical-1', { priority: 'critical', timestamp: '2026-10-21T00:00:03.000Z' }),
      entry('normal-old', { priority: 'normal', timestamp: '2026-10-21T00:00:01.000Z' }),
      entry('high-1', { priority: 'high', timestamp: '2026-10-21T00:00:04.000Z' }),
      entry('normal-old-2', { priority: 'normal', timestamp: '2026-10-21T00:00:01.000Z' }),
    ];
    const ordered = orderInboxEntries(entries);
    // critical → high → normal（timestamp 升序，同键 stable）→ low
    expect(ordered.map(e => e.message.id)).toEqual([
      'critical-1', 'high-1', 'normal-old', 'normal-old-2', 'normal-new', 'low-1',
    ]);
    // 同 priority+timestamp：normal-old 先于 normal-old-2（原顺序稳定保持）
    // 不 mutate 输入
    expect(entries[0].message.id).toBe('low-1');
  });
});

describe('inbox-budget: formattedMessageBytes', () => {
  it('按最终注入 Message 的 JSON UTF-8 字节计量（含 envelope 字段，非原始正文）', () => {
    const m = { role: 'user' as const, content: 'abc', origin: 'user' as const };
    expect(formattedMessageBytes(m as never)).toBe(Buffer.byteLength(JSON.stringify(m), 'utf8'));
    expect(formattedMessageBytes(m as never)).toBeGreaterThan(Buffer.byteLength('abc', 'utf8'));
  });
});

describe('inbox-budget: formatPreparedInbox 预算选择 (Phase 1967 Step B)', () => {
  it('条数预算：3 条 maxItems=2 → 2 selected + 1 deferred；INBOX_INJECT 只发 selected', async () => {
    const audit = createMockAudit();
    const runtime = buildRuntime(audit);
    const entries = [entry('a'), entry('b'), entry('c')];
    const formatted = await runtime.formatPreparedInbox(
      { entries },
      { maxItems: 2, maxFormattedBytes: INBOX_BATCH_MAX_FORMATTED_BYTES },
    );
    expect(formatted.selected.map(e => e.message.id)).toEqual(['a', 'b']);
    expect(formatted.deferred.map(e => e.message.id)).toEqual(['c']);
    expect(formatted.count).toBe(2);
    expect(formatted.injected).toHaveLength(2);
    expect(formatted.oversizedAlone).toBe(false);
    const injects = audit.entries.filter(e => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_INJECT);
    expect(injects).toHaveLength(2);
    expect(injects.map(e => e[1])).toEqual(['file=a.md', 'file=b.md']);
  });

  it('字节预算：按格式化表示累计，超额消息 deferred（含 envelope 开销）', async () => {
    const audit = createMockAudit();
    const runtime = buildRuntime(audit);
    const entries = [entry('a'), entry('b'), entry('c')];
    // 先测出单条实际字节，设 budget = 两条之和（第三条必然超额）
    const probe = await runtime.formatPreparedInbox(
      { entries }, { maxItems: 99, maxFormattedBytes: Number.MAX_SAFE_INTEGER },
    );
    const per = probe.injected.map(m => formattedMessageBytes(m));
    const budget = per[0] + per[1];
    const formatted = await runtime.formatPreparedInbox(
      { entries }, { maxItems: 99, maxFormattedBytes: budget },
    );
    expect(formatted.selected.map(e => e.message.id)).toEqual(['a', 'b']);
    expect(formatted.deferred.map(e => e.message.id)).toEqual(['c']);
    // 反向：预算是格式化表示（含 envelope），不是原始 content 长度
    const rawTotal = entries
      .map(e => Buffer.byteLength(e.message.content, 'utf8'))
      .reduce((x, y) => x + y, 0);
    expect(rawTotal).toBeLessThan(budget);
  });

  it('默认预算（1939 拍板 20/64KiB）：85 条洪峰 → 20 selected + 65 deferred', async () => {
    const audit = createMockAudit();
    const runtime = buildRuntime(audit);
    const entries = Array.from({ length: 85 }, (_, i) => entry(`m${String(i).padStart(2, '0')}`));
    const formatted = await runtime.formatPreparedInbox({ entries });
    expect(formatted.selected).toHaveLength(INBOX_BATCH_MAX_ITEMS);
    expect(formatted.deferred).toHaveLength(85 - INBOX_BATCH_MAX_ITEMS);
    const usedBytes = formatted.injected
      .map(m => formattedMessageBytes(m))
      .reduce((x, y) => x + y, 0);
    expect(usedBytes).toBeLessThanOrEqual(INBOX_BATCH_MAX_FORMATTED_BYTES);
    expect(DEFAULT_INBOX_FORMAT_BUDGET).toEqual({
      maxItems: INBOX_BATCH_MAX_ITEMS,
      maxFormattedBytes: INBOX_BATCH_MAX_FORMATTED_BYTES,
    });
  });

  it('oversized 单条且为当前首条 → 单独放行 + 审计，后续全部 deferred；正文逐字节不变', async () => {
    const audit = createMockAudit();
    const runtime = buildRuntime(audit);
    const bigContent = 'x'.repeat(2048);
    const entries = [entry('big', { content: bigContent }), entry('small-1'), entry('small-2')];
    // budget 大于两条 small、小于 big 的格式化字节
    const probe = await runtime.formatPreparedInbox(
      { entries }, { maxItems: 99, maxFormattedBytes: Number.MAX_SAFE_INTEGER },
    );
    const bigBytes = formattedMessageBytes(probe.injected[0]);
    const smallBytes = formattedMessageBytes(probe.injected[1]);
    const budget = Math.max(smallBytes * 3, bigBytes - 1);
    expect(bigBytes).toBeGreaterThan(budget);

    const formatted = await runtime.formatPreparedInbox(
      { entries }, { maxItems: 99, maxFormattedBytes: budget },
    );
    expect(formatted.oversizedAlone).toBe(true);
    expect(formatted.selected.map(e => e.message.id)).toEqual(['big']);
    expect(formatted.deferred.map(e => e.message.id)).toEqual(['small-1', 'small-2']);
    // 不截断/不摘要：注入正文含完整原文
    const injectedText = formatted.injected[0].content;
    expect(typeof injectedText).toBe('string');
    expect(injectedText as string).toContain(bigContent);
    const auditRow = audit.entries.find(e => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_OVERSIZED_ALONE);
    expect(auditRow).toBeDefined();
    expect(auditRow).toContain(`file=big.md`);
    expect(auditRow).toContain(`bytes=${bigBytes}`);
    expect(auditRow).toContain(`budget_bytes=${budget}`);
  });

  it('oversized 但非首条（本轮已有选中）→ 不搭车，defer 到下一轮；无 oversizedAlone', async () => {
    const audit = createMockAudit();
    const runtime = buildRuntime(audit);
    const bigContent = 'x'.repeat(2048);
    const entries = [entry('small', { priority: 'critical' }), entry('big', { content: bigContent })];
    const probe = await runtime.formatPreparedInbox(
      { entries }, { maxItems: 99, maxFormattedBytes: Number.MAX_SAFE_INTEGER },
    );
    const bigBytes = formattedMessageBytes(probe.injected[1]);
    const budget = bigBytes - 1;
    const formatted = await runtime.formatPreparedInbox(
      { entries }, { maxItems: 99, maxFormattedBytes: budget },
    );
    expect(formatted.oversizedAlone).toBe(false);
    expect(formatted.selected.map(e => e.message.id)).toEqual(['small']);
    expect(formatted.deferred.map(e => e.message.id)).toEqual(['big']);
    expect(audit.entries.some(e => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_OVERSIZED_ALONE)).toBe(false);
  });

  it('priority→age 顺序决定选择：高优先新消息先于低优先旧消息被选中', async () => {
    const audit = createMockAudit();
    const runtime = buildRuntime(audit);
    const entries = [
      entry('low-old', { priority: 'low', timestamp: '2026-10-21T00:00:01.000Z' }),
      entry('critical-new', { priority: 'critical', timestamp: '2026-10-21T00:00:09.000Z' }),
      entry('normal-mid', { priority: 'normal', timestamp: '2026-10-21T00:00:05.000Z' }),
    ];
    const formatted = await runtime.formatPreparedInbox(
      { entries }, { maxItems: 2, maxFormattedBytes: INBOX_BATCH_MAX_FORMATTED_BYTES },
    );
    expect(formatted.selected.map(e => e.message.id)).toEqual(['critical-new', 'normal-mid']);
    expect(formatted.deferred.map(e => e.message.id)).toEqual(['low-old']);
  });

  it('deferred 不产生交付记录：INBOX_INJECT 计数 == selected 计数', async () => {
    const audit = createMockAudit();
    const runtime = buildRuntime(audit);
    const entries = Array.from({ length: 5 }, (_, i) => entry(`m${i}`));
    await runtime.formatPreparedInbox(
      { entries }, { maxItems: 3, maxFormattedBytes: INBOX_BATCH_MAX_FORMATTED_BYTES },
    );
    expect(audit.entries.filter(e => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_INJECT)).toHaveLength(3);
  });
});
