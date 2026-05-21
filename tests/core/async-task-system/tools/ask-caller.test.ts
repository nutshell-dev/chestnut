/**
 * ask-caller tool reject path tests (phase 990 / r121 F fork)
 *
 * Per phase 990 plan §2.2:
 * - 3 real α reject path test (empty question / missing parent context / MarkerNotFoundError catch)
 * - happy-path placeholder REFRAMED-not-test (phase 909 γ-ratify boundary)
 * - outbox claim PHANTOM-not-test (grep 0 outbox hit)
 */
import { describe, it, expect, vi } from 'vitest';
import { createAskCallerTool } from '../../../../src/core/async-task-system/tools/ask-caller.js';
import { MarkerNotFoundError } from '../../../../src/foundation/dialog-store/index.js';
import type { ExecContext } from '../../../../src/foundation/tool-protocol/index.js';
import type { DialogStore } from '../../../../src/foundation/dialog-store/index.js';

function makeCtx(overrides: Partial<ExecContext> = {}): ExecContext {
  return { ...overrides } as ExecContext;
}

describe('askCallerTool (phase 990)', () => {
  it('empty question rejects with missing question error', async () => {
    const tool = createAskCallerTool({});
    const ctx = makeCtx();
    const result = await tool.execute({ question: '' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing question');
    expect(result.content).toContain('question is required');
  });

  it('missing parent context rejects with no main context error', async () => {
    const tool = createAskCallerTool({ mainDialogStore: undefined, mainContextSnapshot: undefined });
    const ctx = makeCtx();
    const result = await tool.execute({ question: 'why?' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('no main context');
    expect(result.content).toContain('parent context not available');
  });

  it('MarkerNotFoundError catch returns marker not found error', async () => {
    const mockSnapshot = { clawId: 'claw-1', toolUseId: 'task-xxx' };
    const mockStore = {
      restorePrefix: vi.fn().mockRejectedValue(new MarkerNotFoundError('claw-1', 'task-xxx')),
    };
    const tool = createAskCallerTool({
      mainDialogStore: mockStore as unknown as DialogStore,
      mainContextSnapshot: mockSnapshot,
    });
    const ctx = makeCtx();
    const result = await tool.execute({ question: 'why?' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('marker not found');
    expect(result.content).toContain('marker not found');
    expect(result.content).toContain('toolUseId=task-xxx');
  });

  // phase 990 plan §2.2: happy-path placeholder + outbox claim intentionally not tested
});
