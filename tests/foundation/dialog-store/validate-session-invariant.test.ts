/**
 * validateSession version invariant + messages corrupt entry filter (phase 1024 G.4)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';

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
