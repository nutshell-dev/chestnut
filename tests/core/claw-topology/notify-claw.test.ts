import { describe, it, expect, vi } from 'vitest';
import { createNotifyClawTool } from '../../../src/core/claw-topology/tools/notify-claw.js';
import type { ExecContext } from '../../../src/foundation/tools/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeBaseCtx(overrides?: Partial<ExecContext>): ExecContext {
  return {
    clawId: 'motion',
    clawDir: '/chestnut/motion',
    clawsDir: '/chestnut/claws',
    workspaceDir: '/chestnut/motion/clawspace',
    syncDir: '/chestnut/motion/sync',
    profile: 'full',
    fs: {} as ExecContext['fs'],
    stopRequested: false,
    requestStop: vi.fn(),
    getElapsedMs: vi.fn().mockReturnValue(0),
    readFileState: new Map(),
    auditWriter: {
      write: vi.fn(),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
      __brand: 'AuditLog',
    } as unknown as AuditLog,
    ...overrides,
  } as ExecContext;
}

describe('createNotifyClawTool abort propagation', () => {
  it('propagates abort from notifyClaw delivery catch', async () => {
    const controller = new AbortController();
    const tool = createNotifyClawTool({
      fs: {} as ExecContext['fs'],
      notifyClaw: async () => {
        controller.abort();
        throw new Error('delivery boom');
      },
      defaultSource: 'motion',
      authorized: true,
      audit: { write: vi.fn(), preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as unknown as AuditLog,
      isClawAlive: () => true,
      formatClawStatusHint: () => undefined,
      clawExists: () => true,
      hasActiveContract: () => true,
    });

    const ctx = makeBaseCtx({ signal: controller.signal });
    await expect(tool.execute({ to: 'clawA', body: 'hello' }, ctx)).rejects.toThrow('Execution aborted');
  });
});
