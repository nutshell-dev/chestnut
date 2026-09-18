/**
 * phase 1847 Step B §6：prepare/format 消息准备边界的真实链组合证明。
 *
 * 全链路真实件：NodeFileSystem + InboxReader + Runtime + EventLoop（真实
 * formatter registry、真实 dialog store）。无模块级 vi.mock；唯一替身是
 * mock LLM（注入 runtime.llm）与可插拔 audit 记录器。
 *
 * 覆盖计划 §6 场景：
 *  ① prepare 只领取不格式化（inflight 原 bytes / formatter / INBOX_INJECT 均零）；
 *     format 不再 claim，元数据/注入文本/顺序与旧 wrapper 一致。
 *  ② 自定义 formatter 拒绝：真实 EventLoop 持有 handles 并 nack 回 pending，
 *     processTurn/provider 零调用、post_drain stage=inbox_format；修复后同消息可处理。
 *  ③ 旧 wrapper drainInbox 遇同一拒绝：回队并抛原 error。
 *  ④ prepare 交接前异常 / prepare 后 stop / format 完成后 stop：未处理消息不进 done。
 *  ⑤ 部分 claim 真实失败：已领取项按原策略可处理，未领取留 pending，错误审计仍有。
 *  ⑥ reload + 普通 + 误路由混合：仅普通进入 prepared、reload 只处理一次、误路由走 owner。
 *  ⑦ nack 失败：原 inflight bytes 保留 + INBOX_NACK_FAILED；恢复审计仍含原 formatter error。
 *  ⑧ 旧 wrapper / 旧子类 override / 准入与 gate 回归由既有套件覆盖
 *     （runtime-draininbox、inbox-reload-intercept、llm-retry-state、event-loop）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import { Runtime } from '../../../src/core/runtime/index.js';
import type { RuntimeDependencies } from '../../../src/core/runtime/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from '../../../src/core/runtime/inbox-message-types.js';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import { encodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import {
  INBOX_PENDING_DIR,
  INBOX_INFLIGHT_DIR,
  INBOX_DONE_DIR,
  INBOX_MISROUTED_DIR,
} from '../../../src/foundation/messaging/index.js';
import type {
  InboxMessage,
  InboxMessageTypeRegistry,
} from '../../../src/foundation/messaging/index.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeRuntimeDeps } from '../../helpers/runtime-deps.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { createMockLLM, createMockLLMConfig } from '../_runtime-test-helpers.js';

const CLAW_ID = 'claw-1';

interface PendingMsg {
  id: string;
  type: string;
  from: string;
  content: string;
  to?: string;
  priority?: InboxMessage['priority'];
  timestamp?: string;
  metadata?: Record<string, string>;
}

interface RealChain {
  dir: string;
  clawDir: string;
  deps: RuntimeDependencies;
  runtime: Runtime;
  audit: AuditLog;
  events: Array<[string, ...(string | number)[]]>;
  pendingDir: string;
  inflightDir: string;
  doneDir: string;
  misroutedDir: string;
  writePending: (msg: PendingMsg) => void;
  /** 目录下 .md 文件名（排序后），用于精确断言文件去向。 */
  listMd: (absDir: string) => string[];
}

const tempDirs: string[] = [];
const runtimesToStop: Runtime[] = [];

afterEach(async () => {
  for (const r of runtimesToStop.splice(0)) await r.stop().catch(() => {});
  for (const d of tempDirs.splice(0)) await cleanupTempDir(d);
});

async function makeRealChain(opts?: {
  customizeRegistry?: (registry: InboxMessageTypeRegistry) => void;
  configReloader?: () => LLMOrchestratorConfig;
  /** audit 事件钩子（如：对指定事件抛错以制造 prepare 交接前异常）。 */
  auditWriteHook?: (event: string) => void;
}): Promise<RealChain> {
  const dir = await createTrackedTempDir('p1847-boundary-');
  tempDirs.push(dir);
  const clawDir = path.join(dir, 'claws', CLAW_ID);
  const recorder = makeAudit();
  const audit = recorder.audit;
  if (opts?.auditWriteHook) {
    const hook = opts.auditWriteHook;
    const orig = audit.write.bind(audit);
    audit.write = ((event: string, ...cols: (string | number)[]) => {
      hook(event);
      orig(event, ...cols);
    }) as AuditLog['write'];
  }
  const deps = await makeRuntimeDeps({
    clawDir,
    clawId: CLAW_ID,
    llmConfig: createMockLLMConfig(),
    auditOverride: audit,
  });
  opts?.customizeRegistry?.(deps.formatterRegistry as InboxMessageTypeRegistry);
  const runtime = new Runtime({
    clawId: CLAW_ID,
    clawDir,
    idleTimeoutMs: 0,
    llmConfig: createMockLLMConfig(),
    ...(opts?.configReloader ? { configReloader: opts.configReloader } : {}),
    dependencies: deps,
  });
  runtimesToStop.push(runtime);
  await runtime.initialize();

  const pendingDir = path.join(clawDir, INBOX_PENDING_DIR);
  const chain: RealChain = {
    dir,
    clawDir,
    deps,
    runtime,
    audit,
    events: recorder.events,
    pendingDir,
    inflightDir: path.join(clawDir, INBOX_INFLIGHT_DIR),
    doneDir: path.join(clawDir, INBOX_DONE_DIR),
    misroutedDir: path.join(clawDir, INBOX_MISROUTED_DIR),
    writePending: (msg) => {
      const full: InboxMessage = {
        id: msg.id,
        type: msg.type,
        from: msg.from,
        to: msg.to ?? CLAW_ID,
        content: msg.content,
        priority: msg.priority ?? 'normal',
        timestamp: msg.timestamp ?? '2026-01-01T00:00:00.000Z',
        ...(msg.metadata ? { metadata: msg.metadata } : {}),
      };
      fsNative.writeFileSync(path.join(pendingDir, `${full.id}.md`), encodeInbox(full));
    },
    listMd: (absDir) => fsNative.readdirSync(absDir).filter((f) => f.endsWith('.md')).sort(),
  };
  return chain;
}

function makeLoop(chain: RealChain): EventLoop {
  return new EventLoop({
    runtime: chain.runtime,
    fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
    agentDir: chain.clawDir,
    clawId: CLAW_ID,
    audit: chain.audit,
    inbox: { pendingDir: chain.pendingDir, fallbackTimeoutMs: 20 },
  });
}

function injectMockLLM(runtime: Runtime, text = 'ok') {
  const mockLLM = createMockLLM([
    { content: [{ type: 'text', text }], stop_reason: 'end_turn' } as LLMResponse,
  ]);
  (runtime as unknown as { llm: unknown }).llm = mockLLM;
  return mockLLM;
}

/** 注册一个可翻转的 throwing custom formatter（A 阶段 premise-probe 同款手法）。 */
function registerRejectableFormatter(
  registry: InboxMessageTypeRegistry,
  marker: Error,
  shouldThrow: { current: boolean },
  recoveredBody: string,
): void {
  registry.register({
    owner: 'p1847-test',
    type: 'p1847_rejectable',
    rendering: {
      kind: 'custom',
      formatter: async () => {
        if (shouldThrow.current) throw marker;
        return recoveredBody;
      },
    },
  });
}

describe('phase1847 prepare/format 边界真实链组合', () => {
  it('① prepare 只领取不格式化；format 不再 claim 且注入与旧 wrapper 一致', async () => {
    const chainA = await makeRealChain();
    const resolveSpy = vi.spyOn(chainA.deps.formatterRegistry, 'resolve');
    chainA.writePending({
      id: 'm-1', type: 'user_chat', from: 'user', content: 'first body',
      timestamp: '2026-01-01T00:00:00.000Z', metadata: { k1: 'v1' },
    });
    chainA.writePending({
      id: 'm-2', type: 'user_chat', from: 'user', content: 'second body',
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    const prepared = await chainA.runtime.prepareInbox();

    // 返回真实 handle + 原消息配对；磁盘 inflight 原 bytes 保持
    expect(prepared.entries).toHaveLength(2);
    expect(prepared.entries.map((e) => e.message.content)).toEqual(['first body', 'second body']);
    for (const e of prepared.entries) {
      expect(e.handle.filePath).toContain(INBOX_INFLIGHT_DIR);
      expect(e.handle.originalFileName).toBe(`${e.message.id}.md`);
    }
    expect(chainA.listMd(chainA.inflightDir)).toHaveLength(2);
    const inflightRaw = fsNative.readFileSync(
      path.join(chainA.inflightDir, chainA.listMd(chainA.inflightDir).find((f) => f.endsWith('m-1.md'))!),
      'utf8',
    );
    expect(inflightRaw).toContain('first body');
    expect(inflightRaw).toContain('k1');
    // 已领取 → pending 空
    expect(chainA.listMd(chainA.pendingDir)).toHaveLength(0);
    // 准备阶段 formatter / INBOX_INJECT 均零
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(chainA.events.filter((e) => e[0] === 'inbox_inject')).toHaveLength(0);

    // 对照链：同字节消息走旧 wrapper
    const chainB = await makeRealChain();
    chainB.writePending({
      id: 'm-1', type: 'user_chat', from: 'user', content: 'first body',
      timestamp: '2026-01-01T00:00:00.000Z', metadata: { k1: 'v1' },
    });
    chainB.writePending({
      id: 'm-2', type: 'user_chat', from: 'user', content: 'second body',
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    const legacy = await chainB.runtime.drainInbox();

    // format 不再 claim（pending 仍空），内容与旧 wrapper 相同（addedAt 时点除外）
    const formatted = await chainA.runtime.formatPreparedInbox(prepared);
    expect(chainA.listMd(chainA.pendingDir)).toHaveLength(0);
    const stripAddedAt = (ms: Message[]) => ms.map(({ addedAt: _addedAt, ...rest }) => rest);
    expect(stripAddedAt(formatted.injected)).toEqual(stripAddedAt(legacy.injected));
    expect(formatted.sources).toEqual(legacy.sources);
    expect(formatted.count).toBe(legacy.count);
    expect(formatted.infos).toEqual(legacy.infos);
    // INBOX_INJECT 审计在 format 阶段发出
    expect(chainA.events.filter((e) => e[0] === 'inbox_inject')).toHaveLength(2);

    // 结算仍归调用方：format 不结算，ack 由调用方执行
    await chainA.runtime.ackHandles(prepared.entries.map((e) => e.handle), 'test_done');
    await chainB.runtime.ackHandles(legacy.addressedHandles, 'test_done');
    expect(chainA.listMd(chainA.doneDir)).toHaveLength(2);
  });

  it('② formatter 拒绝：EventLoop 持句柄 nack 回 pending、LLM 零调用、stage=inbox_format；修复后同消息处理', async () => {
    const marker = new Error('p1847 formatter boom');
    const shouldThrow = { current: true };
    const chain = await makeRealChain({
      customizeRegistry: (registry) =>
        registerRejectableFormatter(registry, marker, shouldThrow, 'recovered body'),
    });
    const mockLLM = injectMockLLM(chain.runtime);
    const processTurnSpy = vi.spyOn(chain.runtime, 'processTurn');
    chain.writePending({ id: 'r-1', type: 'p1847_rejectable', from: 'system', content: 'raw body' });

    const loop = makeLoop(chain);
    await loop.initialize();
    await loop.run();

    // provider / processTurn 零调用
    expect(mockLLM.call).not.toHaveBeenCalled();
    expect(processTurnSpy).not.toHaveBeenCalled();
    // nack 回 pending（原文件名恢复），不进 done/failed
    expect(chain.listMd(chain.pendingDir)).toEqual(['r-1.md']);
    expect(chain.listMd(chain.inflightDir)).toHaveLength(0);
    expect(chain.listMd(chain.doneDir)).toHaveLength(0);
    // 恢复审计：stage=inbox_format + 原 formatter error
    const recovered = chain.events.filter(
      (e) => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].some((c) => c === 'stage=inbox_format')).toBe(true);
    expect(recovered[0].some((c) => String(c).includes('p1847 formatter boom'))).toBe(true);

    // 修复 formatter：同消息不依赖重启被处理并落 done
    shouldThrow.current = false;
    await loop.run();
    expect(mockLLM.call).toHaveBeenCalled();
    expect(chain.listMd(chain.pendingDir)).toHaveLength(0);
    expect(chain.listMd(chain.doneDir).some((f) => f.endsWith('r-1.md'))).toBe(true);
  });

  it('③ 旧 wrapper drainInbox 遇同一 formatter 拒绝：回队并抛原 error', async () => {
    const marker = new Error('p1847 formatter boom');
    const chain = await makeRealChain({
      customizeRegistry: (registry) =>
        registerRejectableFormatter(registry, marker, { current: true }, 'unused'),
    });
    chain.writePending({ id: 'r-1', type: 'p1847_rejectable', from: 'system', content: 'raw body' });

    await expect(chain.runtime.drainInbox()).rejects.toBe(marker);
    // 回队成功：pending 恢复原文件，inflight/done 空
    expect(chain.listMd(chain.pendingDir)).toEqual(['r-1.md']);
    expect(chain.listMd(chain.inflightDir)).toHaveLength(0);
    expect(chain.listMd(chain.doneDir)).toHaveLength(0);
  });

  it('④a prepare 交接前异常：未转交句柄回队（inbox_prepare_failure）并重抛，不进 done', async () => {
    // 用对 inbox_unaddressed 抛错的 audit 钩子，在分流审计处制造交接前未处理异常
    const chain = await makeRealChain({
      auditWriteHook: (event) => {
        if (event === 'inbox_unaddressed') throw new Error('p1847 audit boom');
      },
    });
    chain.writePending({ id: 'n-1', type: 'user_chat', from: 'user', content: 'normal' });
    chain.writePending({
      id: 'x-1', type: 'message', from: 'task_system', to: 'other-claw', content: 'not mine',
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    await expect(chain.runtime.prepareInbox()).rejects.toThrow('p1847 audit boom');
    // 两个句柄（addressed + 尚未交给误路由处理的）都回队，无静默丢失、不进 done/misrouted
    expect(chain.listMd(chain.pendingDir)).toEqual(['n-1.md', 'x-1.md']);
    expect(chain.listMd(chain.inflightDir)).toHaveLength(0);
    expect(chain.listMd(chain.doneDir)).toHaveLength(0);
    expect(chain.listMd(chain.misroutedDir)).toHaveLength(0);
  });

  it('④b prepare 后 stop：未 format、未 LLM，消息回 pending 不进 done', async () => {
    const chain = await makeRealChain();
    const mockLLM = injectMockLLM(chain.runtime);
    const formatSpy = vi.spyOn(chain.runtime, 'formatPreparedInbox');
    chain.writePending({ id: 's-1', type: 'user_chat', from: 'user', content: 'stop me' });

    const loop = makeLoop(chain);
    await loop.initialize();
    const origPrepare = chain.runtime.prepareInbox.bind(chain.runtime);
    vi.spyOn(chain.runtime, 'prepareInbox').mockImplementation(async () => {
      const batch = await origPrepare();
      loop.abort();
      return batch;
    });
    await loop.run();

    expect(formatSpy).not.toHaveBeenCalled();
    expect(mockLLM.call).not.toHaveBeenCalled();
    // 未执行消息回 pending，不进 done
    expect(chain.listMd(chain.pendingDir)).toEqual(['s-1.md']);
    expect(chain.listMd(chain.doneDir)).toHaveLength(0);
  });

  it('④c format 完成后 stop：已格式化未发给 LLM，消息回 pending 不进 done', async () => {
    const chain = await makeRealChain();
    const mockLLM = injectMockLLM(chain.runtime);
    const processTurnSpy = vi.spyOn(chain.runtime, 'processTurn');
    chain.writePending({ id: 's-2', type: 'user_chat', from: 'user', content: 'stop after format' });

    const loop = makeLoop(chain);
    await loop.initialize();
    const origFormat = chain.runtime.formatPreparedInbox.bind(chain.runtime);
    const formatSpy = vi
      .spyOn(chain.runtime, 'formatPreparedInbox')
      .mockImplementation(async (batch) => {
        const formatted = await origFormat(batch);
        loop.abort();
        return formatted;
      });
    await loop.run();

    expect(formatSpy).toHaveBeenCalledTimes(1);
    expect(processTurnSpy).not.toHaveBeenCalled();
    expect(mockLLM.call).not.toHaveBeenCalled();
    expect(chain.listMd(chain.pendingDir)).toEqual(['s-2.md']);
    expect(chain.listMd(chain.doneDir)).toHaveLength(0);
  });

  it('⑤ 部分 claim 真实失败：已领取项按原策略可处理，未领取留 pending，错误审计仍有', async () => {
    const chain = await makeRealChain();
    // 真实失败注入：只让 b-1 的 pending→inflight move 失败
    const realMove = chain.deps.systemFs.move.bind(chain.deps.systemFs);
    vi.spyOn(chain.deps.systemFs, 'move').mockImplementation(async (src: string, dst: string) => {
      if (dst.startsWith(INBOX_INFLIGHT_DIR) && dst.endsWith('b-1.md')) {
        throw new Error('p1847 EIO move boom');
      }
      return realMove(src, dst);
    });
    chain.writePending({
      id: 'a-1', type: 'user_chat', from: 'user', content: 'first',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    chain.writePending({
      id: 'b-1', type: 'user_chat', from: 'user', content: 'second',
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    const prepared = await chain.runtime.prepareInbox();

    // 已领取项返回真实句柄，未领取项留 pending
    expect(prepared.entries).toHaveLength(1);
    expect(prepared.entries[0].message.content).toBe('first');
    expect(chain.listMd(chain.pendingDir)).toEqual(['b-1.md']);
    expect(chain.listMd(chain.inflightDir).some((f) => f.endsWith('a-1.md'))).toBe(true);
    // partial_failure 错误审计保留
    expect(
      chain.events.filter((e) => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_DRAIN_FAILED),
    ).toHaveLength(1);

    // 已领取项仍可按原策略 format + 结算
    const formatted = await chain.runtime.formatPreparedInbox(prepared);
    expect(formatted.count).toBe(1);
    await chain.runtime.ackHandles(prepared.entries.map((e) => e.handle), 'test_done');
    expect(chain.listMd(chain.doneDir).some((f) => f.endsWith('a-1.md'))).toBe(true);
  });

  it('⑥ reload + 普通 + 误路由混合：仅普通进 prepared、reload 只处理一次、误路由走其 owner', async () => {
    const chain = await makeRealChain({ configReloader: () => createMockLLMConfig() });
    chain.writePending({
      id: 'rl-1', type: RELOAD_LLM_CONFIG_MESSAGE_TYPE, from: 'cli', content: 'reload',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    chain.writePending({
      id: 'n-1', type: 'user_chat', from: 'user', content: 'normal',
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    chain.writePending({
      id: 'x-1', type: 'message', from: 'task_system', to: 'other-claw', content: 'not mine',
      timestamp: '2026-01-01T00:00:02.000Z',
    });

    const prepared = await chain.runtime.prepareInbox();

    // 只有普通消息进入 prepared
    expect(prepared.entries).toHaveLength(1);
    expect(prepared.entries[0].message.id).toBe('n-1');
    // reload 只处理一次并 ack 进 done；不入注入
    expect(
      chain.events.filter((e) => e[0] === RUNTIME_AUDIT_EVENTS.LLM_RELOADED),
    ).toHaveLength(1);
    expect(chain.listMd(chain.doneDir).some((f) => f.endsWith('rl-1.md'))).toBe(true);
    // 误路由只走 markMisrouted（misrouted/ 一份，done/pending 均无）
    expect(chain.listMd(chain.misroutedDir).some((f) => f.endsWith('x-1.md'))).toBe(true);
    expect(chain.listMd(chain.doneDir).some((f) => f.endsWith('x-1.md'))).toBe(false);
    expect(chain.listMd(chain.pendingDir)).toHaveLength(0);
    // 控制/误路由句柄不被二次处理：再次 prepare 为空
    const second = await chain.runtime.prepareInbox();
    expect(second.entries).toHaveLength(0);

    await chain.runtime.ackHandles(prepared.entries.map((e) => e.handle), 'test_done');
  });

  it('⑦ nack 失败：原 inflight bytes 保留 + INBOX_NACK_FAILED，恢复审计仍含原 formatter error', async () => {
    const marker = new Error('p1847 formatter boom');
    const chain = await makeRealChain({
      customizeRegistry: (registry) =>
        registerRejectableFormatter(registry, marker, { current: true }, 'unused'),
    });
    chain.writePending({ id: 'r-1', type: 'p1847_rejectable', from: 'system', content: 'raw body' });
    // 让 nack 的 inflight→pending restore 失败（claim 方向不受影响）
    const realMove = chain.deps.systemFs.move.bind(chain.deps.systemFs);
    vi.spyOn(chain.deps.systemFs, 'move').mockImplementation(async (src: string, dst: string) => {
      if (dst.startsWith(INBOX_PENDING_DIR)) throw new Error('p1847 EIO restore boom');
      return realMove(src, dst);
    });

    const loop = makeLoop(chain);
    await loop.initialize();
    await loop.run();

    // 原 inflight bytes 保留（未丢失、未伪装回队成功）
    const inflight = chain.listMd(chain.inflightDir);
    expect(inflight.filter((f) => f.endsWith('r-1.md'))).toHaveLength(1);
    const preserved = fsNative.readFileSync(
      path.join(chain.inflightDir, inflight.find((f) => f.endsWith('r-1.md'))!),
      'utf8',
    );
    expect(preserved).toContain('raw body');
    expect(chain.listMd(chain.pendingDir)).toHaveLength(0);
    expect(chain.listMd(chain.doneDir)).toHaveLength(0);
    // 诚实留证：INBOX_NACK_FAILED + 恢复审计仍含原 formatter error
    expect(
      chain.events.filter((e) => e[0] === RUNTIME_AUDIT_EVENTS.INBOX_NACK_FAILED),
    ).toHaveLength(1);
    const recovered = chain.events.filter(
      (e) => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].some((c) => c === 'stage=inbox_format')).toBe(true);
    expect(recovered[0].some((c) => String(c).includes('p1847 formatter boom'))).toBe(true);
  });
});
