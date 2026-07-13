/**
 * Phase 985 Step B: regime switch archive idempotency + atomic recovery.
 *
 * Real FS test: if archive succeeds but the subsequent new-session save fails,
 * a retry must find current.json already moved away, treat it as a no-op,
 * and still complete the regime switch without data loss.
 */

import { describe, it, expect, vi } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  DialogStore,
  performRegimeSwitch,
  DIALOG_AUDIT_EVENTS,
} from '../../../src/foundation/dialog-store/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { AuditLog } from '../../../src/foundation/audit/types.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';

function makeAudit() {
  const calls: [string, ...(string | number)[]][] = [];
  return {
    __brand: 'AuditLog' as const,
    write: (type: string, ...cols: (string | number)[]) => {
      calls.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
    getCalls: () => calls,
  } as unknown as AuditLog & { getCalls: () => typeof calls };
}

const REGIME_SWITCH_AUDIT_EVENTS = {
  REGIME_SWITCH: 'regime_switch',
  REGIME_SWITCH_COMMITTED: 'regime_switch_committed',
  REGIME_SWITCH_FAILED: 'regime_switch_failed',
  REGIME_SWITCH_HARD_FAIL: 'regime_switch_hard_fail',
};

describe('DialogStore regime switch archive idempotency (phase 985)', () => {
  it('first new-session save fails; retry succeeds and preserves old session in archive', async () => {
    const tempDir = await createTempDir();
    const audit = makeAudit();

    try {
      const fs = new NodeFileSystem({ baseDir: tempDir });
      const currentStore = new DialogStore(
        fs,
        'dialog',
        audit as unknown as AuditLog,
        'current.json',
        'claw-985',
      );

      const oldMessages: Message[] = [{ role: 'user', content: 'hello from old regime' }];
      await currentStore.save({
        systemPrompt: 'old-system-prompt',
        messages: oldMessages,
        toolsForLLM: [] as ToolDefinition[],
      });

      let saveAttempt = 0;
      const dialogStoreFactory = () => {
        const store = new DialogStore(
          fs,
          'dialog',
          audit as unknown as AuditLog,
          'current.json',
          'claw-985',
        );
        const originalSave = store.save.bind(store);
        vi.spyOn(store, 'save').mockImplementation(async (data) => {
          saveAttempt += 1;
          if (saveAttempt === 1) {
            throw new Error('save-fail-on-first-attempt');
          }
          return originalSave(data);
        });
        return store;
      };

      const switchOpts = {
        strategy: 'all' as const,
        newSystemPrompt: 'new-system-prompt',
        currentStore,
        dialogStoreFactory,
        toolsForLLM: [] as ToolDefinition[],
        clawDir: tempDir,
        systemFs: fs,
        audit: audit as unknown as AuditLog,
        auditEvents: REGIME_SWITCH_AUDIT_EVENTS,
      };

      // First attempt: archive succeeds, new-session save fails.
      await expect(performRegimeSwitch(switchOpts)).rejects.toThrow('save-fail-on-first-attempt');

      // Retry: current.json is already archived; archive() must be idempotent.
      const result = await performRegimeSwitch(switchOpts);
      expect(result.inheritedCount).toBe(1);
      expect(result.discardedCount).toBe(0);

      // Current session now reflects the new regime.
      const { session } = await currentStore.load();
      expect(session.systemPrompt).toBe('new-system-prompt');
      expect(session.messages).toEqual(oldMessages);

      // Old session is preserved exactly once in the archive.
      const archives = await currentStore.listArchives();
      expect(archives.length).toBe(1);
      const archived = await currentStore.readArchive(archives[0]);
      expect(archived.systemPrompt).toBe('old-system-prompt');
      expect(archived.messages).toEqual(oldMessages);

      // Audit recorded the idempotent archive path.
      expect(
        audit.getCalls().some((c) => c[0] === DIALOG_AUDIT_EVENTS.ARCHIVE_ALREADY_ARCHIVED),
      ).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
