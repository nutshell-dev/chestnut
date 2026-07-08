/**
 * phase 1414: Runtime.formatInboxMessage 收窄到 registry dispatch + DP 不静默 fallback。
 *
 * Covers:
 * - 6 case 等价行为对照（user_chat / user_inbox_message / claw_crashed / heartbeat / message / unknown）
 * - unknown type 走默 fallback + emit INBOX_UNKNOWN_TYPE audit
 * - Runtime 不再字面持 case 字符串（grep invariant 在 no-runtime-knows-upper-layer-messages.test.ts）
 */

import { describe, it, expect, vi } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import {
  createMessageFormatterRegistry,
  registerMessagingFormatters,
} from '../../../src/foundation/messaging/index.js';
import type { MessageFormatterRegistry } from '../../../src/foundation/messaging/index.js';
import { formatUserChat } from '../../../src/core/gateway/index.js';
import { formatClawCrashed } from '../../../src/watchdog/inbox-formatter.js';
import { createHeartbeatInboxFormatter } from '../../../src/core/heartbeat/index.js';
import { RUNTIME_AUDIT_EVENTS } from '../../../src/core/runtime/runtime-audit-events.js';
import { registerAsyncTaskSystemFormatters } from '../../../src/core/async-task-system/inbox-formatter.js';  // phase 264: hoist

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

describe('phase 1414 Runtime.formatInboxMessage via FormatterRegistry', () => {
  it('user_chat → 透传 body（Gateway formatter）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
    registry.register('user_chat', formatUserChat);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('user_chat', 'user', 'hello world');

    expect(result).toBe('hello world');
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('user_inbox_message → [user inbox message ...]\\nbody（Messaging formatter）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
    registerMessagingFormatters(registry);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('user_inbox_message', 'user', 'msg body');

    expect(result).toMatch(/^\[user inbox message.*\]\nmsg body$/);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('claw_crashed → "[system message<ts>] <body>"（Watchdog formatter / phase 4 drop preamble）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
    registry.register('claw_crashed', formatClawCrashed);
    const runtime = build({ audit, formatterRegistry: registry });

    // phase 4: formatter 不再加 "Claw X process exited abnormally" 前缀
    // 改由 body 自含完整语义 (formatCrashBody per CrashClass)、formatter 仅 wrap [system message<ts>]
    const result = await runtime.testFormatInboxMessage('claw_crashed', 'claw-a', 'exit code 1');

    expect(result).toMatch(/^\[system message\d*\] exit code 1$/);
    expect(result).not.toMatch(/process exited abnormally/);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('heartbeat → "Heartbeat triggered..."（Heartbeat formatter）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const systemFs = { read: vi.fn().mockRejectedValue(enoent) } as any;
    const registry = createMessageFormatterRegistry();
    registry.register('heartbeat', createHeartbeatInboxFormatter({ systemFs, audit: audit as any }));
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('heartbeat', 'sys', '');

    expect(result).toContain('Heartbeat triggered');
    expect(audit.write).not.toHaveBeenCalled();   // ENOENT silent
  });

  it('task_result → [system message ...] body（phase 9: was generic "message" → typed task_result）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
    registerAsyncTaskSystemFormatters(registry);
    const runtime = build({ audit, formatterRegistry: registry });

    const result = await runtime.testFormatInboxMessage('task_result', 'sys', 'generic body');

    expect(result).toMatch(/^\[system message.*\] generic body$/);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('unknown type → 默 fallback + emit INBOX_UNKNOWN_TYPE audit（DP 不静默）', async () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const registry = createMessageFormatterRegistry();
    // 不 register 任何 formatter
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
