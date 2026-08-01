/**
 * phase 1243: Runtime.formatInboxMessage 收窄到 declaration registry dispatch + DP 不静默 fallback。
 *
 * Covers:
 * - 6 case 等价行为对照（user_chat / user_inbox_message / claw_crashed / heartbeat / task_result / unknown）
 * - unknown type 走默 fallback + emit INBOX_UNKNOWN_TYPE audit
 * - Runtime 不再字面持 case 字符串（grep invariant 在 eslint-rules/no-runtime-knows-upper-layer-messages.test.ts）
 */

import { describe, it, expect, vi } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import {
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import type { InboxMessageTypeRegistry } from '../../../src/foundation/messaging/index.js';
import type { GuidanceCompose } from '../../../src/core/runtime/index.js';
import { MESSAGING_INBOX_MESSAGE_TYPES } from '../../../src/foundation/messaging/index.js';
import { GATEWAY_INBOX_MESSAGE_TYPES } from '../../../src/core/gateway/index.js';
import { WATCHDOG_INBOX_MESSAGE_TYPES } from '../../../src/watchdog/inbox-formatter.js';
import { ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES } from '../../../src/core/async-task-system/inbox-formatter.js';
import { createHeartbeatInboxFormatter } from '../../../src/core/heartbeat/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { createMotionGuidanceRegistry } from '../../../src/assembly/guidance/registry.js';
import { composer as clawCrashedComposer } from '../../../src/assembly/guidance/composers/claw-crashed.js';
import { composer as clawInactivityComposer } from '../../../src/assembly/guidance/composers/claw-inactivity.js';

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

interface MinOpts {
  audit: any;
  formatterRegistry: InboxMessageTypeRegistry;
  /** phase 1256 Step A: callback spy 注入（envelope 保真断言） */
  guidanceCompose?: GuidanceCompose;
}

function build(opts: MinOpts): TestRuntime {
  return new TestRuntime({
    clawId: 'test-claw',
    clawDir: '/tmp/test-claw',
    clawsDir: '/tmp/claws',
    idleTimeoutMs: 0,
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    },
    dependencies: {
      systemFs: {} as any,
      auditWriter: opts.audit,
      snapshot: {} as any,
      sessionManager: {} as any,
      inboxReader: {} as any,
      outboxWriter: {} as any,
      llm: {} as any,
      toolRegistry: {
        register: vi.fn(),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        formatForLLM: vi.fn().mockReturnValue([]),
      } as any,
      toolExecutor: {} as any,
      contractManager: {} as any,
      taskSystem: {
        initialize: vi.fn().mockResolvedValue(undefined),
        startDispatch: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as any,
      skillRegistry: {} as any,
      permissionChecker: {} as any,
      fsFactory: () => ({}) as any,
      parentStreamLog: undefined,
      contractNotifyCallback: undefined,
      dialogStoreFactory: vi.fn(),
      formatterRegistry: opts.formatterRegistry,
      guidanceCompose: opts.guidanceCompose,
    },
  });
}

describe('phase 1243 Runtime.formatInboxMessage via declaration registry', () => {
  it('user_chat → 透传 body（Gateway declaration）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, GATEWAY_INBOX_MESSAGE_TYPES);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('user_chat', 'user', 'hello world');

    expect(result).toBe('hello world');
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('user_inbox_message → [user inbox message ...]\\nbody（Messaging declaration）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, MESSAGING_INBOX_MESSAGE_TYPES);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('user_inbox_message', 'user', 'msg body');

    expect(result).toMatch(/^\[user inbox message.*\]\nmsg body$/);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('claw_crashed → "[system message<ts>] <body>"（Watchdog declaration / phase 4 drop preamble）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, WATCHDOG_INBOX_MESSAGE_TYPES);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('claw_crashed', 'claw-a', 'exit code 1');

    expect(result).toMatch(/^\[system message\d*\] exit code 1$/);
    expect(result).not.toMatch(/process exited abnormally/);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('heartbeat → "Heartbeat triggered..."（Heartbeat custom formatter）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const systemFs = { read: vi.fn().mockRejectedValue(enoent) } as any;
    const registry = createInboxMessageTypeRegistry();
    registry.register({
      type: 'heartbeat',
      rendering: { kind: 'custom', formatter: createHeartbeatInboxFormatter({ systemFs, audit: audit as any }) },
    });
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('heartbeat', 'sys', '');

    expect(result).toContain('Heartbeat triggered');
    expect(audit.write).not.toHaveBeenCalled();   // ENOENT silent
  });

  it('task_result → [system message ...] body（phase 9: was generic "message" → typed task_result）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('task_result', 'sys', 'generic body');

    expect(result).toMatch(/^\[system message.*\] generic body$/);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('unknown type → 默 fallback + emit INBOX_UNKNOWN_TYPE audit（DP 不静默）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    // 不 register 任何 declaration
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('mystery_type', 'src', 'body');

    expect(result).toMatch(/^\[system message.*\] body$/);
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.INBOX_UNKNOWN_TYPE,
      'type=mystery_type',
      'from=src',
    );
  });

  it('phase 1256 Step A: guidance callback 收到完整 envelope（type/from/meta 保真、不从 meta 猜测 from）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, WATCHDOG_INBOX_MESSAGE_TYPES);
    const spy = vi.fn().mockReturnValue({ text: 'GUIDANCE-TAIL' });
    const runtime = build({ audit, formatterRegistry: registry, guidanceCompose: spy });

    const result = await runtime.testFormatInboxMessage(
      'claw_crashed',
      'claw-a',
      'exit code 1',
      undefined,
      { crash_class: 'active_unexpected', claw_id: 'clawA' },
    );

    // 同一个调用同时保留 type / from / 指定 meta 字段
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      type: 'claw_crashed',
      from: 'claw-a',
      meta: { crash_class: 'active_unexpected', claw_id: 'clawA' },
    });
    // callback 返回 guidance text 时，原 body + append 行为不变
    expect(result).toMatch(/^\[system message\d*\] exit code 1$/m);
    expect(result).toContain('\n\nGUIDANCE-TAIL');
  });

  it('phase 1256 Step A: 无 extraMeta 时 callback 收到空 meta + 真实 from', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, WATCHDOG_INBOX_MESSAGE_TYPES);
    const spy = vi.fn().mockReturnValue(null);
    const runtime = build({ audit, formatterRegistry: registry, guidanceCompose: spy });

    const result = await runtime.testFormatInboxMessage('claw_crashed', 'claw-b', 'boom');

    expect(spy).toHaveBeenCalledWith({ type: 'claw_crashed', from: 'claw-b', meta: {} });
    expect(result).toMatch(/^\[system message\d*\] boom$/);
  });

  it('phase 1257 Step B: 真实 registry + 合法 v1 wire → guidance append、target = envelope from', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, WATCHDOG_INBOX_MESSAGE_TYPES);
    const guidanceRegistry = createMotionGuidanceRegistry();
    guidanceRegistry.register('claw_crashed', clawCrashedComposer);
    const runtime = build({
      audit,
      formatterRegistry: registry,
      guidanceCompose: (input) => guidanceRegistry.compose(input),
    });

    const result = await runtime.testFormatInboxMessage(
      'claw_crashed',
      'claw-real',
      'exit code 1',
      undefined,
      {
        guidance_schema_version: '1',
        crash_class: 'active_unexpected',
        clean_stop_marker: 'false',
        contract: 'active:c1',
        outbox_pending: '0',
        as_of: '2026-08-01T12:00:00.000Z',
      },
    );

    expect(result).toMatch(/^\[system message\d*\] exit code 1$/m);
    expect(result).toContain('To restart: chestnut claw claw-real daemon');
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('phase 1257 Step B: decoder 失败 → GUIDANCE_COMPOSER_FAILED audit、仅投递原 body（无 fallback/placeholder guidance）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, WATCHDOG_INBOX_MESSAGE_TYPES);
    // 真实 formatter declaration + 真实 guidance registry + 真实 composer（不手写 catch）
    const guidanceRegistry = createMotionGuidanceRegistry();
    guidanceRegistry.register('claw_crashed', clawCrashedComposer);
    const runtime = build({
      audit,
      formatterRegistry: registry,
      guidanceCompose: (input) => guidanceRegistry.compose(input),
    });

    const result = await runtime.testFormatInboxMessage(
      'claw_crashed',
      'claw-a',
      'exit code 1',
      undefined,
      { crash_class: 'mystery' },  // malformed wire：缺 owned fields + 未知 class
    );

    // malformed wire 不阻断 body 投递
    expect(result).toMatch(/^\[system message\d*\] exit code 1$/);
    // formatted result 不含任何 fallback/placeholder guidance
    expect(result).not.toContain('To inspect');
    expect(result).not.toContain('<claw-id>');
    // audit 含 type 与安全 reason（typed decode error / 不回显 metadata）
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED,
      'type=claw_crashed',
      expect.stringContaining('schema_invalid'),
    );
  });

  it('phase 1258 Step B: claw_inactivity 真实 registry + 合法 v1 wire → guidance append、target = meta.claw_id', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, WATCHDOG_INBOX_MESSAGE_TYPES);
    const guidanceRegistry = createMotionGuidanceRegistry();
    guidanceRegistry.register('claw_inactivity', clawInactivityComposer);
    const runtime = build({
      audit,
      formatterRegistry: registry,
      guidanceCompose: (input) => guidanceRegistry.compose(input),
    });

    const result = await runtime.testFormatInboxMessage(
      'claw_inactivity',
      'watchdog',
      'Claw claw-real has been inactive',
      undefined,
      {
        guidance_schema_version: '1',
        claw_id: 'claw-real',
        failure_class: 'daemon_silent',
        inactive_ms: '300000',
        contract: 'active:c1',
        as_of: '2026-08-01T12:00:00.000Z',
      },
    );

    expect(result).toMatch(/^\[system message\d*\] Claw claw-real has been inactive$/m);
    expect(result).toContain('To inspect what the agent is stuck on: chestnut claw claw-real steps');
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('phase 1258 Step B: claw_inactivity decoder 失败 → GUIDANCE_COMPOSER_FAILED audit、仅投递原 body（无 fallback/placeholder guidance）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createInboxMessageTypeRegistry();
    registerInboxMessageTypes(registry, WATCHDOG_INBOX_MESSAGE_TYPES);
    // 真实 formatter declaration + 真实 guidance registry + 真实 composer（不手写 catch）
    const guidanceRegistry = createMotionGuidanceRegistry();
    guidanceRegistry.register('claw_inactivity', clawInactivityComposer);
    const runtime = build({
      audit,
      formatterRegistry: registry,
      guidanceCompose: (input) => guidanceRegistry.compose(input),
    });

    const result = await runtime.testFormatInboxMessage(
      'claw_inactivity',
      'watchdog',
      'Claw claw-real has been inactive',
      undefined,
      { failure_class: 'mystery' },  // malformed wire：缺 owned fields + 未知 class
    );

    // malformed wire 不阻断 body 投递
    expect(result).toMatch(/^\[system message\d*\] Claw claw-real has been inactive$/);
    // formatted result 不含任何 fallback/placeholder guidance
    expect(result).not.toContain('To inspect');
    expect(result).not.toContain('<claw-id>');
    // audit 含 type 与安全 reason（typed decode error / 不回显 metadata）
    expect(audit.write).toHaveBeenCalledWith(
      RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED,
      'type=claw_inactivity',
      expect.stringContaining('schema_invalid'),
    );
  });
});
