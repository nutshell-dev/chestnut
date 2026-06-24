/**
 * phase 517 B3 regression:
 * ContractAuditor.close must abort in-flight LLM call and wait for inflight settle.
 * Previously: callAuditorLLM had no signal; SIGTERM left auditor LLM call hanging.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContractAuditor } from '../../../src/core/contract/contract-auditor.js';

/**
 * Tick delay to let event loop schedule llm.call before we assert receivedSignal.
 * Derivation: 10ms ≥ one Node microtask flush + setTimeout(0) coalesce window
 * （fakeTimer 不适用、需真异步、纯计算 tick 不够稳）.
 */
const EVENT_LOOP_TICK_MS = 10;
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { LLMOrchestrator, LLMResponse } from '../../../src/foundation/llm-orchestrator/index.js';
import type { InboxWriter } from '../../../src/foundation/messaging/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { makeClawId } from '../../../src/foundation/claw-identity/index.js';

function makeAuditMock(): AuditLog {
  return {
    write: vi.fn(),
    message: vi.fn((s: string) => s),
    dispose: vi.fn(),
  } as unknown as AuditLog;
}

function makeFsMock(): FileSystem {
  return {
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue(''),
  } as unknown as FileSystem;
}

function makeInboxMock(): InboxWriter {
  return {
    write: vi.fn().mockResolvedValue(undefined),
  } as unknown as InboxWriter;
}

function makeAuditRequest() {
  return {
    contractId: 'c1',
    contractTitle: 'test contract',
    clawId: makeClawId('test-claw'),
    currentStep: 10,
    auditInterval: 5,
    lastAuditedStep: 0,
    expectations: 'do the thing',
    contractStartedAt: new Date().toISOString(),
    progress: { done: [], in_progress: null, pending: [] },
    recentMessages: undefined,
  };
}

describe('ContractAuditor.close (phase 517 B3)', () => {
  it('aborts in-flight LLM call and resolves close after inflight settles', async () => {
    let receivedSignal: AbortSignal | undefined;
    const llm = {
      call: vi.fn(async (opts: { signal?: AbortSignal }) => {
        receivedSignal = opts.signal;
        // wait until aborted
        return new Promise<LLMResponse>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
      stream: vi.fn(),
      close: vi.fn(),
      reloadConfig: vi.fn(),
    } as unknown as LLMOrchestrator;

    const auditor = new ContractAuditor({
      audit: makeAuditMock(),
      fs: makeFsMock(),
      inbox: makeInboxMock(),
      llm,
      inboxPendingDir: '/tmp/inbox-pending-test',
    });

    // kick off audit (fire-and-forget pattern matches manager.ts:312)
    const auditPromise = auditor.maybeAudit(makeAuditRequest());

    // give event loop a tick so llm.call begins
    await new Promise(r => setTimeout(r, EVENT_LOOP_TICK_MS));
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    // close should abort + wait for settle
    await auditor.close();

    expect(receivedSignal!.aborted).toBe(true);
    // audit promise should resolve to llm_call_failed
    const outcome = await auditPromise;
    expect(outcome.audited).toBe(false);
    expect(outcome.reason).toContain('llm_call_failed');
  });

  it('refuses new maybeAudit after close', async () => {
    const llm = {
      call: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
      reloadConfig: vi.fn(),
    } as unknown as LLMOrchestrator;

    const auditor = new ContractAuditor({
      audit: makeAuditMock(),
      fs: makeFsMock(),
      inbox: makeInboxMock(),
      llm,
      inboxPendingDir: '/tmp/inbox-pending-test',
    });

    await auditor.close();
    const result = await auditor.maybeAudit(makeAuditRequest());
    expect(result.audited).toBe(false);
    expect(result.reason).toBe('auditor_closed');
    expect(llm.call).not.toHaveBeenCalled();
  });

  it('close is idempotent', async () => {
    const auditor = new ContractAuditor({
      audit: makeAuditMock(),
      fs: makeFsMock(),
      inbox: makeInboxMock(),
      llm: { call: vi.fn(), stream: vi.fn(), close: vi.fn(), reloadConfig: vi.fn() } as unknown as LLMOrchestrator,
      inboxPendingDir: '/tmp/inbox-pending-test',
    });

    await auditor.close();
    await auditor.close();  // second call should not throw
    await auditor.close();  // third call too
  });
});
