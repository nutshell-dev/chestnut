/**
 * Phase 921 — deep-dream transient I/O error waterline protection.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  __test_processSession,
  type __test_DreamRunContext,
  type __test_DreamRunPlan,
  type __test_SessionFile,
} from '../../../src/core/memory/deep-dream.js';
import { makeMockAudit } from '../../helpers/audit.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';

describe('processSession waterline behavior (phase 921)', () => {
  function makeCtx(): __test_DreamRunContext {
    return {
      clawId: 'test-claw',
      clawDir: '/tmp/claw',
      clawFs: {} as any,
      motionFs: undefined,
      llm: {
        call: vi.fn(),
        stream: vi.fn(),
        healthCheck: vi.fn(),
        getProviderInfo: vi.fn(),
        close: vi.fn(),
      } as any,
      maxCompressionTokens: 100,
      audit: makeMockAudit(),
    };
  }

  function makePlan(waterline: number): __test_DreamRunPlan {
    return {
      state: {
        lastProcessedDeepDreamAt: waterline,
        currentSessionDreamedDate: '',
      },
      dialogStore: {
        readArchive: vi.fn(),
      } as unknown as DialogStore,
      sessionFiles: [],
      today: '2026-07-12',
    };
  }

  function makeSessionFile(filename: string, tsMs: number): __test_SessionFile {
    return { filename, tsMs };
  }

  it('does not advance waterline on transient EACCES error', async () => {
    const ctx = makeCtx();
    const plan = makePlan(1000);
    const sf = makeSessionFile('2000_archive.json', 2000);

    const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    (plan.dialogStore.readArchive as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const result = await __test_processSession(ctx, sf, plan, [], []);
    expect(result).toEqual({ status: 'skip', reason: 'transient_io' });
    expect(plan.state.lastProcessedDeepDreamAt).toBe(1000);

    const auditCalls = (ctx.audit.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls[0][0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
  });

  it('does not advance waterline on transient EIO error', async () => {
    const ctx = makeCtx();
    const plan = makePlan(1000);
    const sf = makeSessionFile('2000_archive.json', 2000);

    const err = new Error('EIO: i/o error') as NodeJS.ErrnoException;
    err.code = 'EIO';
    (plan.dialogStore.readArchive as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const result = await __test_processSession(ctx, sf, plan, [], []);
    expect(result).toEqual({ status: 'skip', reason: 'transient_io' });
    expect(plan.state.lastProcessedDeepDreamAt).toBe(1000);
  });

  it('advances waterline on permanent JSON parse error', async () => {
    const ctx = makeCtx();
    const plan = makePlan(1000);
    const sf = makeSessionFile('2000_archive.json', 2000);

    const err = new Error('Unexpected token');
    (plan.dialogStore.readArchive as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const result = await __test_processSession(ctx, sf, plan, [], []);
    expect(result).toEqual({ status: 'skip', reason: 'permanent_io' });
    expect(plan.state.lastProcessedDeepDreamAt).toBe(2000);
  });
});
