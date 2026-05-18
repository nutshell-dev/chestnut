/**
 * Runtime — heartbeat HEARTBEAT.md read failed observability (r124 D fork phase 1018)
 *
 * Covers:
 * - ENOENT (not configured) → silent skip, returns base, 0 audit
 * - non-ENOENT (EACCES/IO) → audit CHECKLIST_READ_FAILED, still returns base graceful degrade
 * - Happy path (checklist present) → returns base + checklist, 0 audit
 */

import { describe, it, expect, vi } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { HEARTBEAT_AUDIT_EVENTS } from '../../../src/core/runtime/heartbeat-audit-events.js';

class HeartbeatTestRuntime extends Runtime {
  async testFormatInboxMessage(type: string, from: string, body: string, timestamp?: string): Promise<string> {
    return this.formatInboxMessage(type, from, body, timestamp);
  }
  testSetSystemFs(fs: any): void {
    this.systemFs = fs;
  }
}

function minimalOptions(deps: Partial<any> = {}) {
  return {
    clawId: 'test-claw',
    clawDir: '/tmp/test-claw',
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    },
    dependencies: {
      llm: { close: vi.fn().mockResolvedValue(undefined) } as any,
      toolRegistry: {
        register: vi.fn(),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        formatForLLM: vi.fn().mockReturnValue(''),
      } as any,
      toolExecutor: {} as any,
      contractManager: {} as any,
      taskSystem: {
        initialize: vi.fn().mockResolvedValue(undefined),
        startDispatch: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as any,
      contextInjector: {} as any,
      execContext: {} as any,
      systemFs: {} as any,
      auditWriter: { write: vi.fn() } as any,
      snapshot: {} as any,
      sessionManager: {} as any,
      inboxReader: {} as any,
      outboxWriter: {} as any,
      dialogStoreFactory: vi.fn(),
      ...deps,
    },
  };
}

describe('runtime heartbeat checklist read failed audit', () => {
  it('reverse 1: ENOENT (HEARTBEAT.md not configured) returns base + 0 audit', async () => {
    const auditSpy = vi.fn();
    const runtime = new HeartbeatTestRuntime(minimalOptions({
      auditWriter: { write: auditSpy } as any,
    }));
    runtime.testSetSystemFs({
      read: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    } as any);

    const result = await runtime.testFormatInboxMessage('heartbeat', 'sys', 'body');
    expect(result).toContain('Heartbeat triggered');
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('reverse 2: EACCES (permission) emits CHECKLIST_READ_FAILED audit + returns base', async () => {
    const auditSpy = vi.fn();
    const runtime = new HeartbeatTestRuntime(minimalOptions({
      auditWriter: { write: auditSpy } as any,
    }));
    runtime.testSetSystemFs({
      read: vi.fn().mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
    } as any);

    const result = await runtime.testFormatInboxMessage('heartbeat', 'sys', 'body');
    expect(result).toContain('Heartbeat triggered');
    const emits = auditSpy.mock.calls.filter((c: any[]) => c[0] === HEARTBEAT_AUDIT_EVENTS.CHECKLIST_READ_FAILED);
    expect(emits).toHaveLength(1);
    expect(emits[0].join('|')).toMatch(/code=EACCES/);
  });

  it('reverse 3: happy path checklist configured returns base + checklist + 0 audit', async () => {
    const auditSpy = vi.fn();
    const runtime = new HeartbeatTestRuntime(minimalOptions({
      auditWriter: { write: auditSpy } as any,
    }));
    runtime.testSetSystemFs({
      read: vi.fn().mockResolvedValue('- item A\n- item B'),
    } as any);

    const result = await runtime.testFormatInboxMessage('heartbeat', 'sys', 'body');
    expect(result).toContain('Heartbeat triggered');
    expect(result).toContain('item A');
    expect(result).toContain('item B');
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
