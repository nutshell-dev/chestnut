/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - notify-claw.test.ts
 *  - claw-instance-paths.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNotifyClawTool } from '../../../src/core/claw-topology/tools/notify-claw.js';
import type { ExecContext } from '../../../src/foundation/tools/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { makeClawNotifyTargetResolver } from '../../../src/core/claw-topology/notify-target.js';
import { createClawNotifier } from '../../../src/foundation/messaging/index.js';

describe('notify-claw', () => {
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
        notifyClaw: async () => {
          controller.abort();
          throw new Error('delivery boom');
        },
        defaultSource: 'motion',
        authorized: true,
        sink: { write: vi.fn(), preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as unknown as AuditLog,
        isClawAlive: () => true,
        formatClawStatusHint: () => undefined,
        clawExists: () => true,
        hasActiveContract: () => true,
      });

      const ctx = makeBaseCtx({ signal: controller.signal });
      await expect(tool.execute({ to: 'clawA', body: 'hello' }, ctx)).rejects.toThrow('Execution aborted');
    });
  });
});

describe('notify target resolution (phase 1864 Step C: Messaging owns send)', () => {
  describe('makeClawNotifyTargetResolver', () => {
    let tempDir: string;
    let fs: NodeFileSystem;

    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    const message = {
      type: 'message' as const,
      source: 'motion',
      priority: 'normal' as const,
      body: 'hello',
    };

    it('routeNotifyClaw rejects invalid targetClawId before path derivation', () => {
      const { audit, events } = makeAudit();
      const notifier = createClawNotifier({ fs, audit, resolveTarget: makeClawNotifyTargetResolver(tempDir) });
      expect(() => notifier.notify('../foo', message)).toThrow();
      // phase 944: validation fails before any disk write or audit emit
      expect(events).toHaveLength(0);
    });

    it('routeNotifyClawAsync rejects invalid targetClawId before path derivation', async () => {
      const { audit, events } = makeAudit();
      const notifier = createClawNotifier({ fs, audit, resolveTarget: makeClawNotifyTargetResolver(tempDir) });
      await expect(notifier.notifyAsync('../foo', message)).rejects.toThrow();
      // phase 944: validation fails before any disk write or audit emit
      expect(events).toHaveLength(0);
    });
  });
});
