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
  createMessageFormatterRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import type { MessageFormatterRegistry } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_INBOX_MESSAGE_TYPES } from '../../../src/foundation/messaging/index.js';
import { GATEWAY_INBOX_MESSAGE_TYPES } from '../../../src/core/gateway/index.js';
import { WATCHDOG_INBOX_MESSAGE_TYPES } from '../../../src/watchdog/inbox-formatter.js';
import { ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES } from '../../../src/core/async-task-system/inbox-formatter.js';
import { createHeartbeatInboxFormatter } from '../../../src/core/heartbeat/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';

class TestRuntime extends Runtime {
  async testFormatInboxMessage(type: string, from: string, body: string, timestamp?: string): Promise<string> {
    return this.formatInboxMessage(type, from, body, timestamp);
  }
}

interface MinOpts {
  audit: any;
  formatterRegistry: MessageFormatterRegistry;
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
    },
  });
}

describe('phase 1243 Runtime.formatInboxMessage via declaration registry', () => {
  it('user_chat → 透传 body（Gateway declaration）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
    registerInboxMessageTypes(registry, GATEWAY_INBOX_MESSAGE_TYPES);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('user_chat', 'user', 'hello world');

    expect(result).toBe('hello world');
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('user_inbox_message → [user inbox message ...]\\nbody（Messaging declaration）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
    registerInboxMessageTypes(registry, MESSAGING_INBOX_MESSAGE_TYPES);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('user_inbox_message', 'user', 'msg body');

    expect(result).toMatch(/^\[user inbox message.*\]\nmsg body$/);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('claw_crashed → "[system message<ts>] <body>"（Watchdog declaration / phase 4 drop preamble）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
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
    const registry = createMessageFormatterRegistry();
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
    const registry = createMessageFormatterRegistry();
    registerInboxMessageTypes(registry, ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('task_result', 'sys', 'generic body');

    expect(result).toMatch(/^\[system message.*\] generic body$/);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('unknown type → 默 fallback + emit INBOX_UNKNOWN_TYPE audit（DP 不静默）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
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
});
