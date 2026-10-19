/**
 * phase 320 Step B: Runtime._drainOwnInbox 拦截 reload_llm_config 消息。
 *
 * - reload 消息不入 AI 上下文（不走 formatter / 不入 injected / 不入 sources）
 * - 同批 N 条 reload 触发 1 次 reloadConfig（idempotent）
 * - 混合 reload + 非 reload：reload 旁路处理 + 非 reload 走标准路径
 * - configReloader undefined → audit LLM_RELOAD_SKIPPED，reload 消息仍 ack
 * - configReloader throw → audit LLM_RELOAD_FAILED，reload 消息仍 ack
 */

import { describe, it, expect, vi } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import {
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import { GATEWAY_INBOX_MESSAGE_TYPES } from '../../../src/core/gateway/index.js';
import type { InboxMessageTypeRegistry } from '../../../src/foundation/messaging/index.js';
import type { InboxEntry, InboxHandle } from '../../../src/foundation/messaging/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from '../../../src/core/runtime/inbox-message-types.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/index.js';

class TestRuntime extends Runtime {
  /** Bypass initialize(): wire fields directly that _drainOwnInbox depends on */
  injectForTest(opts: { inboxReader: any; auditWriter: any; llm: any; clawId: string }) {
    (this as any).inboxReader = opts.inboxReader;
    (this as any).auditWriter = opts.auditWriter;
    (this as any).llm = opts.llm;
  }
  async testDrainOwnInbox() {
    return this._drainOwnInbox();
  }
}

interface BuildOpts {
  audit: any;
  inboxReader: any;
  llm: any;
  configReloader?: () => LLMOrchestratorConfig;
  /** Phase 1945 Step C：身份派生/发布注入面（缺省 = 不发布，行为与 phase 1826 一致）。 */
  configIdentityOf?: (config: LLMOrchestratorConfig) => string;
  appliedLLMIdentityPublisher?: (identity: string) => Promise<{
    previousIdentity?: string;
    previousFact: 'ok' | 'missing' | 'malformed';
  }>;
  formatterRegistry?: InboxMessageTypeRegistry;
}

function build(opts: BuildOpts): TestRuntime {
  const registry = opts.formatterRegistry ?? createInboxMessageTypeRegistry();
  registerInboxMessageTypes(registry, GATEWAY_INBOX_MESSAGE_TYPES);
  return new TestRuntime({
    clawId: 'test-claw',
    clawDir: '/tmp/test-claw',
    idleTimeoutMs: 0,
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    } as any,
    configReloader: opts.configReloader,
    ...(opts.configIdentityOf ? { configIdentityOf: opts.configIdentityOf } : {}),
    ...(opts.appliedLLMIdentityPublisher
      ? { appliedLLMIdentityPublisher: opts.appliedLLMIdentityPublisher }
      : {}),
    dependencies: {
      systemFs: {} as any,
      auditWriter: opts.audit,
      snapshot: {} as any,
      sessionManager: {} as any,
      inboxReader: opts.inboxReader,
      llm: opts.llm,
      toolRegistry: {
        register: vi.fn(),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        formatForLLM: vi.fn().mockReturnValue([]),
      } as any,
      toolExecutor: {} as any,
      contractManager: {} as any,
      taskSystem: {} as any,
      skillRegistry: {} as any,
      permissionChecker: {} as any,
      fsFactory: () => ({}) as any,
      dialogStoreFactory: vi.fn(),
      formatterRegistry: registry,
    },
  } as any);
}

function mkEntry(type: string, filePath: string, body = 'x'): InboxEntry {
  return {
    filePath,
    message: {
      id: filePath,
      type: type as any,
      from: 'cli',
      to: '',
      content: body,
      priority: 'high',
      timestamp: new Date().toISOString(),
    },
  };
}

function mkHandle(filePath: string): InboxHandle {
  return { filePath, originalFileName: filePath.split('/').pop()! };
}

function mkAudit() {
  return {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  };
}

const stubCfg: LLMOrchestratorConfig = {
  primary: { name: 'reloaded-primary', apiKey: 'k', model: 'm', apiFormat: 'anthropic' as const } as any,
  fallbacks: [],
  maxAttempts: 1,
  retryDelayMs: 0,
  events: { emit: () => {} },
};

describe('phase 320 Step B: Runtime intercepts reload_llm_config', () => {
  it('single reload entry: reloadConfig 调 1 次 + audit LLM_RELOADED + injected 空 + 消息 ack', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const inboxReader = {
      init: vi.fn().mockResolvedValue({ kind: 'ready', recovered: 0 }),  // phase 1781: typed InboxInitResult
      drainAndDeliver: vi.fn().mockResolvedValue({
        kind: 'complete' as const,  // phase 1782: typed InboxDeliveryResult
        entries: [mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/a.md')],
        handles: [mkHandle('/p/a.md')],
      }),
      ack,
    };

    const rt = build({ audit, inboxReader, llm, configReloader: reloader });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    const result = await rt.testDrainOwnInbox();

    expect(reloader).toHaveBeenCalledTimes(1);
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(reloadFn).toHaveBeenCalledWith(stubCfg);
    expect(result.injected).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOADED,
      expect.stringContaining('provider=reloaded-primary'),
      expect.stringContaining('fallbacks=0'),
      expect.stringContaining('triggered_by=1'),
      // Phase 1826: 应用时记录配置身份修订（owner 借此重新评估、重复修订不重放）。
      expect.stringContaining('revision='),
    );
  });

  it('mixed: 1 reload + 1 user_chat → reload 旁路 + user_chat 走 formatter', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, GATEWAY_INBOX_MESSAGE_TYPES);
    const inboxReader = {
      init: vi.fn().mockResolvedValue({ kind: 'ready', recovered: 0 }),  // phase 1781: typed InboxInitResult
      drainAndDeliver: vi.fn().mockResolvedValue({
        kind: 'complete' as const,  // phase 1782: typed InboxDeliveryResult
        entries: [
          mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/reload.md'),
          mkEntry('user_chat', '/p/chat.md', 'hi'),
        ],
        handles: [mkHandle('/p/reload.md'), mkHandle('/p/chat.md')],
      }),
      ack,
    };

    const rt = build({ audit, inboxReader, llm, configReloader: reloader, formatterRegistry: registry });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    const result = await rt.testDrainOwnInbox();

    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(result.count).toBe(1);  // 仅 user_chat 计入 turn
    expect(result.injected.length).toBe(1);
    // reload handle 立即 ack；user_chat 由 turn end 时 ack（返 addressedHandles 等 caller 处理）
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/p/reload.md' }));
    expect(result.addressedHandles.length).toBe(1);
    expect(result.addressedHandles[0].filePath).toBe('/p/chat.md');
  });

  it('phase 1847: reload + 普通 + 误路由混合 —— reload 只处理一次且不被二次误路由，仅普通消息进入 prepared', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const markMisrouted = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, GATEWAY_INBOX_MESSAGE_TYPES);
    const misroutedEntry: InboxEntry = {
      filePath: '/p/other.md',
      message: {
        id: '/p/other.md',
        type: 'message' as never,
        from: 'task_system',
        to: 'other-claw',
        content: 'not for me',
        priority: 'high',
        timestamp: new Date().toISOString(),
      },
    };
    const inboxReader = {
      init: vi.fn().mockResolvedValue({ kind: 'ready', recovered: 0 }),  // phase 1781: typed InboxInitResult
      drainAndDeliver: vi.fn().mockResolvedValue({
        kind: 'complete' as const,  // phase 1782: typed InboxDeliveryResult
        entries: [
          mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/reload.md'),
          mkEntry('user_chat', '/p/chat.md', 'hi'),
          misroutedEntry,
        ],
        handles: [mkHandle('/p/reload.md'), mkHandle('/p/chat.md'), mkHandle('/p/other.md')],
      }),
      ack,
      markMisrouted,
    };

    const rt = build({ audit, inboxReader, llm, configReloader: reloader, formatterRegistry: registry });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    const prepared = await rt.prepareInbox();

    // reload 旁路处理一次（控制句柄只属于控制处理）
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/p/reload.md' }));
    // 误路由只走其 owner：仅 /p/other.md，reload 句柄不被误路由集合二次选中
    expect(markMisrouted).toHaveBeenCalledTimes(1);
    expect(markMisrouted).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/p/other.md' }));
    // 仅普通消息进入 prepared（未格式化、未结算）
    expect(prepared.entries.map(e => e.handle.filePath)).toEqual(['/p/chat.md']);
    expect(prepared.entries[0].message.content).toBe('hi');
  });

  it('同批 N 条 reload 触发 1 次 reloadConfig（idempotent）', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const inboxReader = {
      init: vi.fn().mockResolvedValue({ kind: 'ready', recovered: 0 }),  // phase 1781: typed InboxInitResult
      drainAndDeliver: vi.fn().mockResolvedValue({
        kind: 'complete' as const,  // phase 1782: typed InboxDeliveryResult
        entries: [
          mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/r1.md'),
          mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/r2.md'),
          mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/r3.md'),
        ],
        handles: [mkHandle('/p/r1.md'), mkHandle('/p/r2.md'), mkHandle('/p/r3.md')],
      }),
      ack,
    };

    const rt = build({ audit, inboxReader, llm, configReloader: reloader });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    await rt.testDrainOwnInbox();

    expect(reloader).toHaveBeenCalledTimes(1);
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(3);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOADED,
      expect.anything(),
      expect.anything(),
      expect.stringContaining('triggered_by=3'),
      expect.stringContaining('revision='),
    );
  });

  it('configReloader undefined → audit LLM_RELOAD_SKIPPED + 消息仍 ack + 不 throw', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const inboxReader = {
      init: vi.fn().mockResolvedValue({ kind: 'ready', recovered: 0 }),  // phase 1781: typed InboxInitResult
      drainAndDeliver: vi.fn().mockResolvedValue({
        kind: 'complete' as const,  // phase 1782: typed InboxDeliveryResult
        entries: [mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/a.md')],
        handles: [mkHandle('/p/a.md')],
      }),
      ack,
    };

    const rt = build({ audit, inboxReader, llm });  // 无 configReloader
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    const result = await rt.testDrainOwnInbox();

    expect(reloadFn).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOAD_SKIPPED,
      expect.stringContaining('count=1'),
      expect.stringContaining('no_reloader_configured'),
    );
    expect(result.injected).toEqual([]);
  });

  it('configReloader throw → audit LLM_RELOAD_FAILED + 消息仍 ack + 不 throw', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => { throw new Error('disk read failed'); });
    const inboxReader = {
      init: vi.fn().mockResolvedValue({ kind: 'ready', recovered: 0 }),  // phase 1781: typed InboxInitResult
      drainAndDeliver: vi.fn().mockResolvedValue({
        kind: 'complete' as const,  // phase 1782: typed InboxDeliveryResult
        entries: [mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/a.md')],
        handles: [mkHandle('/p/a.md')],
      }),
      ack,
    };

    const rt = build({ audit, inboxReader, llm, configReloader: reloader });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    const result = await rt.testDrainOwnInbox();

    expect(reloader).toHaveBeenCalledTimes(1);
    expect(reloadFn).not.toHaveBeenCalled();  // reloader throw、未调到 llm.reloadConfig
    expect(ack).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOAD_FAILED,
      expect.stringContaining('disk read failed'),
    );
    expect(result.injected).toEqual([]);
  });
});

describe('Phase 1826: Runtime 控制入口（等待期间）', () => {
  it('consumePendingControls：应用最新配置并返回身份修订；同修订不重复应用；不 claim 消息', async () => {
    const audit = mkAudit();
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const peekPending = vi.fn().mockResolvedValue({
      entries: [mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/r.md')],
      issues: [],
    });
    const inboxReader = { peekPending };

    const rt = build({ audit, inboxReader, llm, configReloader: reloader });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });

    const first = await rt.consumePendingControls();
    expect(first.consumed).toBe(1);
    expect(typeof first.configRevision).toBe('string');
    expect(reloadFn).toHaveBeenCalledTimes(1);

    // 消息仍留在 pending（由正常 drain 消费一次），控制入口只 peek。
    expect(peekPending).toHaveBeenCalledTimes(1);

    // 同修订重复通知：不重复 reloadConfig（防二次重载清空 breaker 历史）。
    const second = await rt.consumePendingControls();
    expect(second.configRevision).toBe(first.configRevision);
    expect(reloadFn).toHaveBeenCalledTimes(1);
  });

  it('无控制消息时 consumed=0，不触碰配置', async () => {
    const audit = mkAudit();
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const inboxReader = {
      peekPending: vi.fn().mockResolvedValue({ entries: [mkEntry('user_chat', '/p/c.md')], issues: [] }),
    };

    const rt = build({ audit, inboxReader, llm, configReloader: reloader });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });

    const result = await rt.consumePendingControls();
    expect(result.consumed).toBe(0);
    expect(reloader).not.toHaveBeenCalled();
    expect(reloadFn).not.toHaveBeenCalled();
  });
});

/**
 * Phase 1945 Step C：热重载成功后发布「已应用」LLM 身份。
 *
 * - 成功：reloadConfig 后 publisher 收到 configIdentityOf(config) 派生的身份，
 *   audit LLM_RELOADED 带 identity=/previous_identity=/previous_fact= 证据；
 * - apply 失败：不发布、audit LLM_RELOAD_FAILED；
 * - 发布失败：独立 audit LLM_IDENTITY_PUBLISH_FAILED（不伪装 reload 失败），
 *   下一条同 revision reload 命中 skip 时补偿重试；
 * - skip 不伪造：revision 相同但快照身份不同（revision 投影外字段变化）→
 *   不发布未 apply 的身份；
 * - 无注入（claw/测试）：行为与 phase 1826 一致，无新 audit。
 */
describe('Phase 1945 Step C: 热重载后发布 applied LLM identity', () => {
  function mkReloadInbox(ack: vi.Mock) {
    return {
      init: vi.fn().mockResolvedValue({ kind: 'ready', recovered: 0 }),
      drainAndDeliver: vi.fn().mockResolvedValue({
        kind: 'complete' as const,
        entries: [mkEntry(RELOAD_LLM_CONFIG_MESSAGE_TYPE, '/p/a.md')],
        handles: [mkHandle('/p/a.md')],
      }),
      ack,
    };
  }

  it('重载成功 + 发布成功：publisher 收到派生身份；LLM_RELOADED 带 identity/previous 证据；消息 ack', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const publisher = vi.fn().mockResolvedValue({ previousIdentity: 'id-old', previousFact: 'ok' });
    const inboxReader = mkReloadInbox(ack);

    const rt = build({
      audit, inboxReader, llm,
      configReloader: reloader,
      configIdentityOf: () => 'id-new',
      appliedLLMIdentityPublisher: publisher,
    });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    const result = await rt.testDrainOwnInbox();

    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(reloadFn).toHaveBeenCalledWith(stubCfg);
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledWith('id-new');
    expect(ack).toHaveBeenCalledTimes(1);
    expect(result.injected).toEqual([]);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOADED,
      expect.stringContaining('provider=reloaded-primary'),
      expect.stringContaining('fallbacks=0'),
      expect.stringContaining('triggered_by=1'),
      expect.stringContaining('revision='),
      'identity=id-new',
      'previous_identity=id-old',
      'previous_fact=ok',
    );
    expect(audit.write).not.toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_IDENTITY_PUBLISH_FAILED,
      expect.anything(),
    );
  });

  it('apply 失败（reloadConfig throw）→ LLM_RELOAD_FAILED；publisher 零调用', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const llm = { reloadConfig: vi.fn(() => { throw new Error('provider rejected'); }) };
    const reloader = vi.fn(() => stubCfg);
    const publisher = vi.fn().mockResolvedValue({ previousFact: 'ok' });
    const inboxReader = mkReloadInbox(ack);

    const rt = build({
      audit, inboxReader, llm,
      configReloader: reloader,
      configIdentityOf: () => 'id-new',
      appliedLLMIdentityPublisher: publisher,
    });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    await rt.testDrainOwnInbox();

    expect(publisher).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOAD_FAILED,
      expect.stringContaining('provider rejected'),
    );
    expect(audit.write).not.toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_IDENTITY_PUBLISH_FAILED,
      expect.anything(),
    );
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('发布失败 → 独立 audit LLM_IDENTITY_PUBLISH_FAILED（不写 RELOAD_FAILED）；下一条同 revision reload 命中 skip 并补偿重试', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const publisher = vi.fn()
      .mockRejectedValueOnce(new Error('pm write failed'))
      .mockResolvedValueOnce({ previousIdentity: 'id-old', previousFact: 'ok' });
    const inboxReader = mkReloadInbox(ack);

    const rt = build({
      audit, inboxReader, llm,
      configReloader: reloader,
      configIdentityOf: () => 'id-new',
      appliedLLMIdentityPublisher: publisher,
    });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });

    // 第一次：apply 成功、发布失败 → 独立事件，reload 本身仍记成功
    await rt.testDrainOwnInbox();
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_IDENTITY_PUBLISH_FAILED,
      'identity=id-new',
      expect.stringContaining('pm write failed'),
    );
    expect(audit.write).not.toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOAD_FAILED,
      expect.anything(),
    );
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOADED,
      expect.stringContaining('provider=reloaded-primary'),
      expect.stringContaining('fallbacks=0'),
      expect.stringContaining('triggered_by=1'),
      expect.stringContaining('revision='),
      'identity=id-new',
    );

    // 第二次：同 revision → skip already_applied + 补偿重试发布（不再 reloadConfig）
    await rt.testDrainOwnInbox();
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledTimes(2);
    expect(publisher).toHaveBeenNthCalledWith(2, 'id-new');
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOAD_SKIPPED,
      expect.stringContaining('count=1'),
      'reason=already_applied',
      expect.stringContaining('revision='),
    );
  });

  it('skip 不伪造：revision 相同但快照身份不同（投影外字段变化）→ 不发布未 apply 的身份', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    // revision 投影只含 name/apiFormat/model/baseUrl/apiKey；改 timeoutMs 不改变 revision
    const driftedCfg: LLMOrchestratorConfig = {
      ...stubCfg,
      primary: { ...stubCfg.primary, timeoutMs: 12345 } as any,
    };
    const reloader = vi.fn()
      .mockReturnValueOnce(stubCfg)
      .mockReturnValueOnce(driftedCfg);
    const identityOf = vi.fn()
      .mockReturnValueOnce('id-a')
      .mockReturnValue('id-b');
    const publisher = vi.fn().mockResolvedValue({ previousFact: 'missing' });
    const inboxReader = mkReloadInbox(ack);

    const rt = build({
      audit, inboxReader, llm,
      configReloader: reloader,
      configIdentityOf: identityOf,
      appliedLLMIdentityPublisher: publisher,
    });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });

    await rt.testDrainOwnInbox();
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledWith('id-a');

    await rt.testDrainOwnInbox();
    // skip 分支：不重新派生身份、不发布（无 pending）——不宣称 id-b 已应用
    expect(identityOf).toHaveBeenCalledTimes(1);
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOAD_SKIPPED,
      expect.stringContaining('count=1'),
      'reason=already_applied',
      expect.stringContaining('revision='),
    );
  });

  it('身份派生失败 → 独立 audit（reason=identity_derivation_failed）+ 登记 pending，reload 仍记成功', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const publisher = vi.fn().mockResolvedValue({ previousFact: 'ok' });
    const inboxReader = mkReloadInbox(ack);

    const rt = build({
      audit, inboxReader, llm,
      configReloader: reloader,
      configIdentityOf: () => { throw new Error('derive exploded'); },
      appliedLLMIdentityPublisher: publisher,
    });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    await rt.testDrainOwnInbox();

    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(publisher).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_IDENTITY_PUBLISH_FAILED,
      expect.stringContaining('reason=identity_derivation_failed'),
      expect.stringContaining('revision='),
    );
    expect(audit.write).not.toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOAD_FAILED,
      expect.anything(),
    );
  });

  it('无身份注入（claw/测试 double）：行为与 phase 1826 一致——零发布、零新 audit、LLM_RELOADED 无 identity 列', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const inboxReader = mkReloadInbox(ack);

    const rt = build({ audit, inboxReader, llm, configReloader: reloader });
    rt.injectForTest({ inboxReader, auditWriter: audit, llm, clawId: 'test-claw' });
    await rt.testDrainOwnInbox();

    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_RELOADED,
      expect.stringContaining('provider=reloaded-primary'),
      expect.stringContaining('fallbacks=0'),
      expect.stringContaining('triggered_by=1'),
      expect.stringContaining('revision='),
    );
    expect(audit.write).not.toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.LLM_IDENTITY_PUBLISH_FAILED,
      expect.anything(),
    );
  });
});
