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
  createMessageFormatterRegistry,
  registerMessagingFormatters,
} from '../../../src/foundation/messaging/index.js';
import type { MessageFormatterRegistry } from '../../../src/foundation/messaging/index.js';
import type { InboxEntry, InboxHandle } from '../../../src/foundation/messaging/index.js';
import { RUNTIME_AUDIT_EVENTS, RELOAD_LLM_CONFIG_MESSAGE_TYPE } from '../../../src/core/runtime/runtime-audit-events.js';
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
  formatterRegistry?: MessageFormatterRegistry;
}

function build(opts: BuildOpts): TestRuntime {
  const registry = opts.formatterRegistry ?? createMessageFormatterRegistry();
  registerMessagingFormatters(registry);
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
    dependencies: {
      systemFs: {} as any,
      auditWriter: opts.audit,
      snapshot: {} as any,
      sessionManager: {} as any,
      inboxReader: opts.inboxReader,
      outboxWriter: {} as any,
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
      clawSubdirs: [],
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
      init: vi.fn(),
      drainAndDeliver: vi.fn().mockResolvedValue({
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
    );
  });

  it('mixed: 1 reload + 1 user_chat → reload 旁路 + user_chat 走 formatter', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const registry = createMessageFormatterRegistry();
    registry.register('user_chat', async ({ body }) => body);
    const inboxReader = {
      init: vi.fn(),
      drainAndDeliver: vi.fn().mockResolvedValue({
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

  it('同批 N 条 reload 触发 1 次 reloadConfig（idempotent）', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const reloader = vi.fn(() => stubCfg);
    const inboxReader = {
      init: vi.fn(),
      drainAndDeliver: vi.fn().mockResolvedValue({
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
    );
  });

  it('configReloader undefined → audit LLM_RELOAD_SKIPPED + 消息仍 ack + 不 throw', async () => {
    const audit = mkAudit();
    const ack = vi.fn().mockResolvedValue(undefined);
    const reloadFn = vi.fn();
    const llm = { reloadConfig: reloadFn };
    const inboxReader = {
      init: vi.fn(),
      drainAndDeliver: vi.fn().mockResolvedValue({
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
      init: vi.fn(),
      drainAndDeliver: vi.fn().mockResolvedValue({
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
