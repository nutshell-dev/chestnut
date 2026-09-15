/**
 * phase 1834 (M07 语义治理)：claw_outbox_summary 新语义的真实生产链组合验收。
 *
 * 接管 tests/templates/messages/inbox-text-equivalence.test.ts 移交的 M07 整组
 * （golden 历史数据保留、不逐字节比较）。本文件不 stub owner codec、不用自制
 * composer / 逆编码器：scan/tick → InboxWriter 落盘 → InboxReader 读回 →
 * owner codec decode → Assembly typed binding → CLIProtocol 渲染 →
 * Runtime.formatInboxMessage 最终文本，全链真实模块。
 *
 * 覆盖（Step B §6）：
 *  1. 两 claw 各 2/1 条 → 最终消息完整正文 + 两个实际读取指令（各自真实 limit）
 *  2. pending/inflight/24h 内 done 同 hash 不重发；历史 A→B→A 证明「历史重复」
 *     不等于「与上一条提醒相同」，正文只陈述事实
 *  3. 直接 write 传 incomplete state 被真实 codec 拒绝（writer 零调用）
 *  4. 纯模板兜底：截断/多行/空首行/空预览/缺预览（缺 preview 仅模板能力，
 *     不声称生产扫描会产生缺 preview —— scan 对 found 总给 preview）
 *  5. 真实 CLI drain：limit 是上限且消费后归档；扫描后新增/被他人消费时
 *     动态范围以实际读取为准（确定性步骤，不靠 sleep）
 *  6. 合法 legacy wire 走新指引；旧正文保持原样（含旧 skip 提示不重写）；
 *     未知版本/不合法 counts 走 GUIDANCE_COMPOSER_FAILED 审计 + 正文保留
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { runOutboxSummaryTick } from '../../../src/core/claw-topology/jobs/outbox-summary/tick.js';
import { writeNewSummary, SUMMARY_INBOX_TYPE } from '../../../src/core/claw-topology/jobs/outbox-summary/write.js';
import { DEDUP_DONE_WINDOW_MS } from '../../../src/core/claw-topology/jobs/outbox-summary/dedup.js';
import { decodeOutboxSummaryGuidance } from '../../../src/core/claw-topology/jobs/outbox-summary/guidance-state.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { InboxReader, InboxWriter, makeInboxPath, INBOX_INFLIGHT_DIR } from '../../../src/foundation/messaging/index.js';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { createInboxMessageTypeRegistry } from '../../../src/foundation/messaging/index.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { createMotionGuidanceRegistry } from '../../../src/assembly/guidance/registry.js';
import { clawOutboxSummaryGuidanceBinding } from '../../../src/assembly/guidance/bindings/claw-outbox-summary.js';
import { registerCliGuidance } from '../../../src/cli-protocol/index.js';
import { drainOutbox } from '../../../src/cli/commands/claw-outbox.js';
import {
  outboxSummaryHead,
  outboxSummaryClawLine,
  outboxSummaryScopeHint,
  outboxSummaryRepeatHint,
  outboxSummaryIncompleteWarning,
  outboxSummaryBody,
} from '../../../src/templates/messages/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

const SCOPE_LINE_1 = '预览仅展示各 claw 最后一条消息的首行片段，不代表全部未读内容。';
const SCOPE_LINE_2 = '需要了解消息内容时，可使用下方读取命令。命令会读取并消费消息，消费后归档；--limit 是最多读取条数，不绑定本次扫描的消息集合。消息可能已被消费或有新消息到达，以实际读取结果为准。';
const REPEAT_NOTICE = '这些消息曾出现在历史未读提醒中；重复提醒不表示你已读取过消息正文。';
const READ_PREFIX = '读取并消费（最多 --limit 指定的条数）：';

function makeMsg(content: string, ts: string) {
  return {
    id: `m-${ts}`,
    type: 'report' as const,
    from: 'clawA',
    to: 'motion',
    content,
    timestamp: ts,
    priority: 'normal' as const,
  };
}

function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => { events.push([type, ...cols]); },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

/** Runtime 最终呈现装配：真实 formatter registry + 真实 guidance registry/binding（同 Runtime 现有测试装配模式）。 */
class TestRuntime extends Runtime {
  async testFormatInboxMessage(
    type: string,
    from: string,
    body: string,
    timestamp?: string,
    extraMeta?: Record<string, string>,
  ): Promise<string> {
    return this.formatInboxMessage(type, from, body, timestamp, extraMeta);
  }
}

function buildRuntime(audit: ReturnType<typeof makeAudit>['audit']): TestRuntime {
  const formatterRegistry = createInboxMessageTypeRegistry();
  formatterRegistry.register({
    owner: 'runtime-test',
    type: SUMMARY_INBOX_TYPE,
    rendering: { kind: 'standard', presentation: 'system' },
  });
  const guidanceRegistry = createMotionGuidanceRegistry();
  registerCliGuidance(guidanceRegistry, [clawOutboxSummaryGuidanceBinding]);
  return new TestRuntime({
    clawId: 'motion',
    clawDir: '/tmp/test-motion',
    clawsDir: '/tmp/claws',
    idleTimeoutMs: 0,
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    },
    dependencies: {
      systemFs: {} as never,
      auditWriter: audit,
      snapshot: {} as never,
      sessionManager: {} as never,
      inboxReader: {} as never,
      llm: {} as never,
      toolRegistry: {
        register: vi.fn(),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        formatForLLM: vi.fn().mockReturnValue([]),
      } as never,
      toolExecutor: {} as never,
      contractManager: {} as never,
      taskSystem: {
        initialize: vi.fn().mockResolvedValue(undefined),
        startDispatch: vi.fn(),
        shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
      } as never,
      skillRegistry: {} as never,
      permissionChecker: {} as never,
      fsFactory: () => ({}) as never,
      contractNotifyCallback: undefined,
      dialogStoreFactory: vi.fn(),
      formatterRegistry,
      guidanceCompose: (input) => guidanceRegistry.compose(input),
    },
  });
}

describe('phase 1834: claw_outbox_summary 新语义真实生产链', () => {
  let root: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let events: ReturnType<typeof makeAudit>['events'];
  let inboxReader: InboxReader;
  let inboxWriter: InboxWriter;
  let outboxReader: OutboxReader;
  let topology: ClawTopology;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `outbox-summary-semantics-${randomUUID()}`);
    await fsAsync.mkdir(path.join(root, 'claws'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'motion/inbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'motion/inbox/done'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'motion/inbox/failed'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'motion', INBOX_INFLIGHT_DIR), { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    ({ audit, events } = makeAudit());
    inboxReader = new InboxReader(
      path.join(root, 'motion/inbox/pending'),
      path.join(root, 'motion/inbox/done'),
      path.join(root, 'motion/inbox/failed'),
      fs,
      audit,
    );
    inboxWriter = InboxWriter.__internal_create(
      fs,
      makeInboxPath(path.join(root, 'motion/inbox/pending')),
      audit,
      MESSAGING_WRITER_LIMITS_DEFAULT,
    );
    outboxReader = new OutboxReader(fs, audit);
    topology = createClawTopology({
      fs,
      chestnutRoot: root,
      motionClawId: makeClawId('motion'),
      motionDir: 'motion',
    });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  async function seedOutbox(clawId: string, files: Readonly<Record<string, string>>): Promise<void> {
    const dir = path.join(root, 'claws', clawId, 'outbox/pending');
    await fsAsync.mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await fsAsync.writeFile(path.join(dir, name), encodeOutbox(makeMsg(content, '2026-09-14T10:00:00Z')));
    }
  }

  async function tick(): Promise<void> {
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
  }

  /** 真实 InboxReader 读回唯一 pending summary（drainAndDeliver claim 到 inflight，调用方负责 ack/nack）。 */
  async function drainOnlySummary() {
    const result = await inboxReader.drainAndDeliver();
    expect(result.kind).toBe('complete');
    expect(result.entries).toHaveLength(1);
    expect(result.handles).toHaveLength(1);
    return { entry: result.entries[0], handle: result.handles[0] };
  }

  async function ageDoneSummaries(): Promise<void> {
    const doneDir = path.join(root, 'motion/inbox/done');
    const old = Date.now() - DEDUP_DONE_WINDOW_MS - 60_000;
    for (const name of await fsAsync.readdir(doneDir)) {
      if (!name.endsWith('.md')) continue;
      await fsAsync.utimes(path.join(doneDir, name), old / 1000, old / 1000);
    }
  }

  async function pendingSummaryCount(): Promise<number> {
    const names = await fsAsync.readdir(path.join(root, 'motion/inbox/pending'));
    return names.filter(n => n.endsWith('.md')).length;
  }

  it('首次提醒全链：真实 scan/tick→InboxWriter→InboxReader→codec→binding→Runtime 最终文本', async () => {
    await seedOutbox('claw-a', {
      'a1.md': '较早的报告\n第一批细节',
      'a2.md': '已完成数据整理\n第二批细节',
    });
    await seedOutbox('claw-b', { 'b1.md': '有一项需要确认\n确认项细节' });
    await tick();

    const { entry } = await drainOnlySummary();
    const msg = entry.message;
    expect(msg.type).toBe(SUMMARY_INBOX_TYPE);
    expect(msg.from).toBe('system');
    expect(msg.to).toBe('motion');
    expect(msg.priority).toBe('normal');
    // 真实 codec 产出的 v1 wire（不手写 metadata）
    expect(msg.metadata).toEqual({
      guidance_schema_version: '1',
      'summary-hash': expect.stringMatching(/^[0-9a-f]{12}$/),
      counts: JSON.stringify({ 'claw-a': 2, 'claw-b': 1 }),
      total_claws: '2',
      total_msgs: '3',
    });

    const final = await buildRuntime(audit).testFormatInboxMessage(
      msg.type,
      msg.from,
      msg.content,
      undefined,
      msg.metadata,
    );

    // 完整正文（预览只取各 claw 最后一条首行）+ 空行 + 逐 claw 实际读取指令
    expect(final).toBe(
      '[system message] 未读消息提醒：扫描发现 2 个 claw 共 3 条未读消息。\n'
      + '- claw-a：2 条；最后一条预览：「已完成数据整理」\n'
      + '- claw-b：1 条；最后一条预览：「有一项需要确认」\n'
      + `${SCOPE_LINE_1}\n`
      + `${SCOPE_LINE_2}\n`
      + '\n'
      + `${READ_PREFIX}chestnut claw claw-a outbox --limit 2\n`
      + `${READ_PREFIX}chestnut claw claw-b outbox --limit 1`,
    );
    // 不残留旧语义：无 skip 建议、无占位 target、无「已读」推断
    expect(final).not.toContain('outbox-skip');
    expect(final).not.toContain('<claw-id>');
    expect(final).not.toContain('查看具体内容');
    expect(events.some(e => e[0] === 'cron_outbox_summary_written')).toBe(true);
  });

  it('dedup：pending / inflight / 24h 内 done 同 hash 不重发；历史 A→B→A 才附重复提示且不冒称与上一条相同', async () => {
    await seedOutbox('claw-a', { 'a1.md': 'A 消息' });
    await tick();
    expect(await pendingSummaryCount()).toBe(1);

    // pending 同 hash → 不重发
    await tick();
    expect(await pendingSummaryCount()).toBe(1);

    // inflight（claim 未 ack）同 hash → 不重发
    const first = await drainOnlySummary();
    await tick();
    expect(await pendingSummaryCount()).toBe(0);

    await inboxReader.ack(first.handle);
    await tick();
    // 24h 内 done 同 hash → 不重发
    expect(await pendingSummaryCount()).toBe(0);
    await ageDoneSummaries();

    // B（新 hash）→ 首次语义无重复提示
    await seedOutbox('claw-a', { 'a2.md': 'B 消息' });
    await tick();
    expect(await pendingSummaryCount()).toBe(1);
    const second = await drainOnlySummary();
    expect(second.entry.message.content).not.toContain(REPEAT_NOTICE);
    await inboxReader.ack(second.handle);
    await ageDoneSummaries();

    // 回到 A（删 a2）：历史中有 A（更早）与 B（更近）——当前 A 是历史重复，
    // 但与上一条提醒（B）不同；正文只陈述「曾出现」事实。
    await fsAsync.rm(path.join(root, 'claws/claw-a/outbox/pending/a2.md'));
    await tick();
    expect(await pendingSummaryCount()).toBe(1);
    const third = await drainOnlySummary();
    const body = third.entry.message.content;
    expect(body).toContain(REPEAT_NOTICE);
    expect(body).not.toContain('与上一条');
    expect(body).not.toContain('已看过');
    expect(body).not.toContain('无需处理');
    expect(body).not.toContain('不再提醒');
    expect(body).not.toContain('outbox-skip');
    // 重复提示在正文末（scope hint 之后）
    expect(body.indexOf(SCOPE_LINE_1)).toBeLessThan(body.indexOf(REPEAT_NOTICE));
  });

  it('空队列不投递（无 write、无 audit）', async () => {
    await tick();
    expect(await pendingSummaryCount()).toBe(0);
    expect(events.some(e => e[0] === 'cron_outbox_summary_written')).toBe(false);
  });

  it('直接 write 传 incomplete state 被真实 codec 拒绝，writer 零调用（不 stub codec）', async () => {
    const writer = { write: vi.fn() };
    await expect(writeNewSummary(
      { inboxWriter: writer as never, audit, now: () => Date.parse('2026-09-14T10:00:00Z') },
      {
        counts: { 'claw-a': 1 },
        total_claws: 1,
        total_msgs: 1,
        file_set: ['claw-a:a1.md'],
        hash: 'abcdef123456',
        previews: { 'claw-a': 'x' },
        failed_claws: ['claw-b'],
        incomplete: true,
      },
    )).rejects.toThrow(/incomplete/);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('纯模板兜底：截断/多行/空首行/空预览/缺预览均不代表全队列', () => {
    // 缺 preview 仅测试模板能力——生产 scan 对 peek found 总给 preview，不假称会产生缺省。
    expect(outboxSummaryClawLine('claw-a', 2, undefined))
      .toBe('- claw-a：2 条；最后一条预览：「(无预览)」');
    // 空预览（scan 对空首行的原始返回值如 `(空消息)` 由 scan 提供，模板原样呈现）
    expect(outboxSummaryClawLine('claw-a', 1, '')).toBe('- claw-a：1 条；最后一条预览：「」');
    expect(outboxSummaryClawLine('claw-a', 1, '(空消息)')).toBe('- claw-a：1 条；最后一条预览：「(空消息)」');
    // 截断片段原样呈现（截断本身归 scan.truncatePreview，见 scan-preview 测试）
    expect(outboxSummaryClawLine('claw-a', 3, '截断片段…')).toBe('- claw-a：3 条；最后一条预览：「截断片段…」');
    expect(outboxSummaryHead(2, 3)).toBe('未读消息提醒：扫描发现 2 个 claw 共 3 条未读消息。');
    // 范围说明防单条预览代表全队列
    expect(outboxSummaryScopeHint()).toBe(`${SCOPE_LINE_1}\n${SCOPE_LINE_2}`);
    expect(outboxSummaryRepeatHint()).toEqual(['', REPEAT_NOTICE]);
    expect(outboxSummaryIncompleteWarning(['claw-c', 'claw-d']))
      .toBe('警告：以下 claw 扫描失败，计数可能不完整 — claw-c, claw-d');
    expect(outboxSummaryBody(['a', 'b'])).toBe('a\nb');
  });

  it('真实 CLI drain：limit 是读取上限且消费后归档；扫描后新增/被他人消费以实际读取为准', async () => {
    // ① 上限 + 归档：扫描时 2 条，limit=2 全部读走并归档 done
    await seedOutbox('claw-a', { 'a1.md': '第一条', 'a2.md': '第二条' });
    await tick();
    const { entry } = await drainOnlySummary();
    const guidance = decodeOutboxSummaryGuidance({
      type: entry.message.type,
      from: entry.message.from,
      meta: entry.message.metadata!,
    });
    const clawFs = new NodeFileSystem({ baseDir: path.join(root, 'claws/claw-a') });
    const drainAudit = audit as unknown as AuditLog;
    const first = await drainOutbox(clawFs, drainAudit, { limit: guidance.counts['claw-a'] });
    expect(first.drained).toHaveLength(2);
    // claimNext 返回原始文件内容（outbox codec markdown，未解码）——断言正文片段被真实读出
    expect(first.drained.some(c => c.includes('第一条'))).toBe(true);
    expect(first.drained.some(c => c.includes('第二条'))).toBe(true);
    expect(first.remaining).toBe(0);
    const doneFiles = await fsAsync.readdir(path.join(root, 'claws/claw-a/outbox/done'));
    expect(doneFiles.filter(f => f.endsWith('.md'))).toHaveLength(2);

    // ② 扫描后新增消息：limit=2 是上限（扫描时 2 条），新到的第 3 条不被上限覆盖
    await seedOutbox('claw-a', { 'b1.md': '新一批一', 'b2.md': '新一批二' });
    const second = await drainOutbox(clawFs, drainAudit, { limit: 2 });
    expect(second.drained).toHaveLength(2);
    expect(second.remaining).toBe(0);
    await seedOutbox('claw-a', { 'b3.md': '扫描后新到' });
    const third = await drainOutbox(clawFs, drainAudit, { limit: 2 });
    expect(third.drained).toHaveLength(1); // 实际只剩 1 条，上限不虚构消息
    expect(third.remaining).toBe(0);

    // ③ 原消息被他人消费：另一 reader 先消费 1 条，limit=2 实际只读到剩余 1 条
    await seedOutbox('claw-a', { 'c1.md': '会被他人消费', 'c2.md': '剩余可读' });
    const otherReader = new OutboxReader(fs, audit);
    const claimed = await otherReader.claimNext('claws/claw-a');
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('unreachable');
    await otherReader.markDone('claws/claw-a', claimed.claimPath, claimed.filename);
    const fourth = await drainOutbox(clawFs, drainAudit, { limit: 2 });
    expect(fourth.drained).toHaveLength(1);
    expect(fourth.remaining).toBe(0);
    // 不断言精确快照对应：被消费的是哪一条不由本测试锁定（动态范围语义）
  });

  it('合法 legacy wire 走新逐 claw 指引；旧正文（含历史 skip 提示）保持原样不重写', async () => {
    const runtime = buildRuntime(audit);
    // 旧持久正文：phase 1834 前的 skip 提示样式，本 phase 不重写历史磁盘消息
    const legacyBody =
      '[system] outbox 未读：共 1 个 claw 1 条消息\n'
      + '- clawA (1): 「旧预览」\n'
      + '\n'
      + '〔提示〕以上未读消息与此前推送完全重复。若你已确认这些消息无需处理，可执行以下命令跳过对应 claw 的未读消息（归档到 done/、不再提醒）：\n'
      + '  chestnut claw clawA outbox-skip --all';
    const final = await runtime.testFormatInboxMessage(
      SUMMARY_INBOX_TYPE,
      'system',
      legacyBody,
      undefined,
      {
        // 合法 legacy production shape（缺 version，旧字段齐全且一致）
        'summary-hash': 'abc123def456',
        hash: 'abc123def456',
        counts: JSON.stringify({ clawA: 1 }),
        total_claws: '1',
        total_msgs: '1',
        failed_claws: '[]',
        incomplete: 'false',
      },
    );
    // 旧正文逐字保留（限制可见：历史消息不自动改写）
    expect(final).toContain(legacyBody);
    // guidance 用新语义：具体 claw + 各自 limit + 消费说明
    expect(final).toContain(`${READ_PREFIX}chestnut claw clawA outbox --limit 1`);
    expect(final).not.toContain('<claw-id>');
    expect(events.some(e => e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED)).toBe(false);
  });

  it('未知版本 / 不合法 counts → GUIDANCE_COMPOSER_FAILED 审计 + 正文保留（无自由文本 fallback）', async () => {
    const runtime = buildRuntime(audit);
    const body = '未读消息提醒：扫描发现 1 个 claw 共 1 条未读消息。';

    const unknownVersion = await runtime.testFormatInboxMessage(
      SUMMARY_INBOX_TYPE,
      'system',
      body,
      undefined,
      {
        guidance_schema_version: '2',
        'summary-hash': 'abc123def456',
        counts: JSON.stringify({ clawA: 1 }),
        total_claws: '1',
        total_msgs: '1',
      },
    );
    expect(unknownVersion).toBe(`[system message] ${body}`);
    expect(events.some(e =>
      e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED
      && typeof e[2] === 'string' && (e[2] as string).includes('unknown_schema_version'),
    )).toBe(true);

    events.length = 0;
    const badCounts = await runtime.testFormatInboxMessage(
      SUMMARY_INBOX_TYPE,
      'system',
      body,
      undefined,
      {
        guidance_schema_version: '1',
        'summary-hash': 'abc123def456',
        counts: 'not-json',
        total_claws: '1',
        total_msgs: '1',
      },
    );
    expect(badCounts).toBe(`[system message] ${body}`);
    expect(badCounts).not.toContain(READ_PREFIX);
    expect(events.some(e =>
      e[0] === RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED
      && typeof e[2] === 'string' && (e[2] as string).includes('schema_invalid'),
    )).toBe(true);
  });
});
