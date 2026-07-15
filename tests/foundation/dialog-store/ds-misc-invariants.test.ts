/**
 * DS misc invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - re-entry-storm.test.ts
 *  - read-archive-path-traversal.test.ts
 *  - validate-session-invariant.test.ts
 *  - flush-promise-serialize.test.ts
 *  - store-corrupted-poisoned-reset.test.ts
 *  - regime-switch-atomicity.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSession } from '../../helpers/session-fixtures.js';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { performRegimeSwitch } from '../../../src/foundation/dialog-store/index.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';

describe('re-entry-storm', () => {
  function makeMockAudit() {
    return { write: vi.fn() };
  }

  function makeMockFs(opts: {
    currentContent: string;
    moveThrows?: boolean;
    archives?: Array<{ name: string; content: string }>;
  }): FileSystem {
    const archiveMap = new Map(opts.archives?.map(a => [`dialog/archive/${a.name}`, a.content]));
    return {
      read: vi.fn(async (p: string) => {
        if (p === 'dialog/current.json') return opts.currentContent;
        if (archiveMap.has(p)) return archiveMap.get(p)!;
        const err = new Error(`ENOENT: ${p}`) as any;
        err.code = 'ENOENT';
        throw err;
      }),
      move: vi.fn(async () => {
        if (opts.moveThrows) {
          const err = new Error('EPERM: not permitted') as any;
          err.code = 'EPERM';
          throw err;
        }
      }),
      list: vi.fn(async (p: string) => {
        if (p === 'dialog/archive') {
          return (opts.archives ?? []).map((a, i) => ({
            name: a.name,
            path: `dialog/archive/${a.name}`,
            isFile: true,
            isDirectory: false,
            size: a.content.length,
            mtime: new Date(1000 + i),
          } as FileEntry));
        }
        return [];
      }),
      ensureDir: vi.fn(async () => {}),
      writeAtomic: vi.fn(async () => {}),
      append: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      isDirectory: vi.fn(async () => false),
      stat: vi.fn(async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
      writeAtomicSync: vi.fn(() => {}),
      writeExclusiveSync: vi.fn(() => {}),
      readSync: vi.fn(() => ''),
      readBytesSync: vi.fn(() => Buffer.from('')),
      appendSync: vi.fn(() => {}),
      statSync: vi.fn(() => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
      moveSync: vi.fn(() => {}),
      existsSync: vi.fn(() => false),
      ensureDirSync: vi.fn(() => {}),
      listSync: vi.fn(() => []),
      deleteSync: vi.fn(() => {}),
      resolve: vi.fn((p: string) => `/base/${p}`),
    } as unknown as FileSystem;
  }

  describe('DialogStore re-entry storm', () => {
    it('rename 失败后下次 load 不再尝试 parse', async () => {
      const audit = makeMockAudit();
      const fs = makeMockFs({
        currentContent: '{ invalid json',
        moveThrows: true,
        archives: [
          {
            name: '1000_recover.json',
            content: JSON.stringify(makeSession({
              clawId: 'c1',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
              systemPrompt: 'sp',
              messages: [{ role: 'user', content: 'hi' }],
            })),
          },
        ],
      });
      const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

      // act 1: 首次 load → audit CORRUPTED + CORRUPTED_ISOLATE_FAILED + 走 archive
      const r1 = await store.load();
      expect(r1.source).toBe('archive');
      expect(r1.session.messages).toHaveLength(1);

      const corruptedCalls = audit.write.mock.calls.filter(
        (c: unknown[]) => c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED,
      );
      const isolateFailedCalls = audit.write.mock.calls.filter(
        (c: unknown[]) => c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED_ISOLATE_FAILED,
      );
      expect(corruptedCalls).toHaveLength(1);
      expect(isolateFailedCalls).toHaveLength(1);

      // act 2: 二次 load → 0 NEW CORRUPTED audit / 直接走 archive
      audit.write.mockClear();
      const r2 = await store.load();
      expect(r2.source).toBe('archive');
      expect(r2.session.messages).toHaveLength(1);

      const corruptedCalls2 = audit.write.mock.calls.filter(
        (c: unknown[]) => c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED,
      );
      expect(corruptedCalls2).toHaveLength(0);

      const recoveredCalls2 = audit.write.mock.calls.filter(
        (c: unknown[]) => c[0] === DIALOG_AUDIT_EVENTS.RECOVERED,
      );
      expect(recoveredCalls2).toHaveLength(1);
    });
  });
});

describe('read-archive-path-traversal', () => {
  describe('DialogStore readArchive path containment (phase 921)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    let audit: ReturnType<typeof makeAudit>;
    let store: DialogStore;
    const filename = 'current.json';
    const clawId = 'test-claw';

    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
      audit = makeAudit();
      store = new DialogStore(fs, '', audit.audit, filename, clawId);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('rejects path traversal in readArchive', async () => {
      await expect(store.readArchive('../../current.json')).rejects.toThrow(/Invalid archive filename/);
    });

    it('rejects nested path traversal in readArchive', async () => {
      await expect(store.readArchive('foo/../../current.json')).rejects.toThrow(/Invalid archive filename/);
    });

    it('rejects directory traversal dots in readArchive', async () => {
      await expect(store.readArchive('..')).rejects.toThrow(/Invalid archive filename/);
    });
  });
});

/**
 * validateSession version invariant + messages corrupt entry filter (phase 1024 G.4)
 */
describe('validate-session-invariant', () => {
  describe('validateSession invariant (phase 1024 G.4)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    let audit: ReturnType<typeof makeAudit>;
    let store: DialogStore;
    const filename = 'current.json';
    const clawId = 'test-claw';

    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
      audit = makeAudit();
      store = new DialogStore(fs, '', audit.audit, filename, clawId);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('validateSession version > 2 emits INVARIANT_FAILED + fallback to 2', () => {
      // Directly test private validateSession (bypass detectAndMigrateVersion which already rejects > 2)
      const session = (store as any).validateSession({
        version: 99,
        clawId,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        systemPrompt: '',
        messages: [],
        toolsForLLM: [],
      });
      expect(session.version).toBe(2);

      const invariantEvents = audit.events.filter(
        (e) => e[0] === DIALOG_AUDIT_EVENTS.INVARIANT_FAILED,
      );
      expect(invariantEvents).toHaveLength(1);
      expect(invariantEvents[0]).toEqual(
        expect.arrayContaining([
          DIALOG_AUDIT_EVENTS.INVARIANT_FAILED,
          'field=version',
          'got=99',
          'fallback=2',
        ]),
      );
    });

    it('messages corrupt entries are filtered with INVARIANT_FAILED audit', async () => {
      const badData = {
        version: 2,
        clawId,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        systemPrompt: '',
        messages: [
          { role: 'user', content: 'valid' },
          null,
          { role: 'assistant', content: 'also valid' },
          'not-an-object',
          { role: 'user', content: 'last valid' },
        ],
        toolsForLLM: [],
      };

      await fs.writeAtomic('current.json', JSON.stringify(badData));

      const result = await store.load();
      expect(result.session.messages).toHaveLength(3);
      expect(result.session.messages[0].content).toBe('valid');
      expect(result.session.messages[1].content).toBe('also valid');
      expect(result.session.messages[2].content).toBe('last valid');

      const invariantEvents = audit.events.filter(
        (e) => e[0] === DIALOG_AUDIT_EVENTS.INVARIANT_FAILED && String(e[1]).includes('messages.entry'),
      );
      expect(invariantEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('version 1 and 2 are accepted without audit', async () => {
      for (const v of [1, 2]) {
        audit.events.length = 0;
        const data = {
          version: v,
          clawId,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          systemPrompt: '',
          messages: [],
          toolsForLLM: [],
        };
        await fs.writeAtomic('current.json', JSON.stringify(data));
        const result = await store.load();
        expect(result.session.version).toBe(v);

        const invariantEvents = audit.events.filter(
          (e) => e[0] === DIALOG_AUDIT_EVENTS.INVARIANT_FAILED,
        );
        expect(invariantEvents).toHaveLength(0);
      }
    });
  });
});

/**
 * DialogStore concurrent save() serialize via flushPromise chain (phase 1024 G.2)
 */
describe('flush-promise-serialize', () => {
  /**
   * Mock writeAtomic 慢写时长 (20ms)：让 serialize chain race 实际有窗口.
   * Derivation: > microtask flush / 给 concurrent save B 在 A 之 awaitAtomic 中段进入 chain.
   */
  const MOCK_SLOW_WRITE_MS = 20;

  /**
   * Settle 等 flushPromise 不应 resolve 的负断言窗口 (10ms).
   * Derivation: > microtask flush / 给 flush.then 跑过 1 turn 后断 flushResolved=false.
   */
  const FLUSH_NEGATIVE_SETTLE_MS = 10;

  describe('DialogStore flushPromise serialize (phase 1024 G.2)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    let audit: ReturnType<typeof makeAudit>;
    let store: DialogStore;
    const filename = 'current.json';
    const clawId = 'test-claw';

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
      audit = makeAudit();
      store = new DialogStore(fs, '', audit.audit, filename, clawId);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('concurrent save() serialize via flushPromise chain (A then B)', async () => {
      const writeOrder: string[] = [];
      vi.spyOn(fs, 'writeAtomic').mockImplementation(async (_path, content) => {
        const text = typeof content === 'string' ? content : String(content);
        writeOrder.push(text);
        await new Promise((r) => setTimeout(r, MOCK_SLOW_WRITE_MS)); // simulate slow write
      });

      await Promise.all([
        store.save({ systemPrompt: 'A', messages: [], toolsForLLM: [] }),
        store.save({ systemPrompt: 'B', messages: [], toolsForLLM: [] }),
      ]);

      // Both writes should have happened, in some deterministic order
      expect(writeOrder).toHaveLength(2);
      expect(writeOrder[0]).toContain('A');
      expect(writeOrder[1]).toContain('B');
    });

    it('getFlushPromise returns the pending save promise', async () => {
      let resolveWrite: () => void = () => {};
      vi.spyOn(fs, 'writeAtomic').mockImplementation(async () => {
        await new Promise<void>((r) => { resolveWrite = r; });
      });

      const savePromise = store.save({ systemPrompt: 'pending', messages: [], toolsForLLM: [] });
      const flushPromise = store.getFlushPromise();

      // flushPromise should not resolve until writeAtomic resolves
      let flushResolved = false;
      flushPromise.then(() => { flushResolved = true; });

      await new Promise((r) => setTimeout(r, FLUSH_NEGATIVE_SETTLE_MS));
      expect(flushResolved).toBe(false);

      resolveWrite();
      await savePromise;
      await flushPromise;
      expect(flushResolved).toBe(true);
    });

    it('chain survives a rejected save (subsequent saves still execute)', async () => {
      let shouldReject = true;
      const writeOrder: string[] = [];
      vi.spyOn(fs, 'writeAtomic').mockImplementation(async (_path, content) => {
        const text = typeof content === 'string' ? content : String(content);
        writeOrder.push(text);
        if (shouldReject) {
          shouldReject = false;
          throw new Error('disk full');
        }
      });

      const p1 = store.save({ systemPrompt: 'fail', messages: [], toolsForLLM: [] });
      const p2 = store.save({ systemPrompt: 'ok', messages: [], toolsForLLM: [] });

      await expect(p1).rejects.toThrow('disk full');
      await expect(p2).resolves.toBeUndefined();

      expect(writeOrder).toHaveLength(2);
      expect(writeOrder[0]).toContain('fail');
      expect(writeOrder[1]).toContain('ok');
    });
  });
});

describe('store-corrupted-poisoned-reset', () => {
  describe('DialogStore phase 988: corruptedPoisoned reset on save + archive (data loss prevention)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    let audit: ReturnType<typeof makeAudit>;
    let store: DialogStore;
    const filename = 'current.json';
    const clawId = 'test-claw';

    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
      audit = makeAudit();
      store = new DialogStore(fs, '', audit.audit, filename, clawId);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('save() resets corruptedPoisoned after successful writeAtomic (G.1 data loss prevention)', async () => {
      // setUp: simulate poisoned state (would result from line 85 corruption-isolate-fail)
      (store as any).corruptedPoisoned = true;

      // save 新内容
      const snapshot = {
        systemPrompt: 'test prompt',
        messages: [{ role: 'user' as const, content: 'test msg' }],
        toolsForLLM: [],
      };
      await store.save(snapshot);

      // 反向：corruptedPoisoned 已 reset
      expect((store as any).corruptedPoisoned).toBe(false);

      // 反向：next load() 读 current.json 不跳到 archive
      const result = await store.load();
      expect(result.source).toBe('current');
      expect(result.session.systemPrompt).toBe('test prompt');
      expect(result.session.messages).toHaveLength(1);
      expect(result.session.messages[0].content).toBe('test msg');
    });

    it('archive() resets corruptedPoisoned after successful move (G.2 fresh cold-start)', async () => {
      // setUp: 先 save 一次让 current.json 存在
      await store.save({
        systemPrompt: 'pre-archive',
        messages: [],
        toolsForLLM: [],
      });

      // setUp: simulate poisoned state
      (store as any).corruptedPoisoned = true;

      // archive
      await store.archive();

      // 反向：corruptedPoisoned 已 reset
      expect((store as any).corruptedPoisoned).toBe(false);

      // 反向：next load() cold-start（current.json 不存在、archive 1 entry pre-archive content）
      // archive() 后 next load 仍走 archive recovery path（current.json 已 move 走、是正确行为）
      // 但 corruptedPoisoned reset 后下次 save → load 周期可走 current 路径
      await store.save({
        systemPrompt: 'post-archive',
        messages: [],
        toolsForLLM: [],
      });
      const result = await store.load();
      expect(result.source).toBe('current');
      expect(result.session.systemPrompt).toBe('post-archive');
    });
  });
});

/**
 * Phase 985 Step B: regime switch archive idempotency + atomic recovery.
 *
 * Real FS test: if archive succeeds but the subsequent new-session save fails,
 * a retry must find current.json already moved away, treat it as a no-op,
 * and still complete the regime switch without data loss.
 */
describe('regime-switch-atomicity', () => {
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
});
