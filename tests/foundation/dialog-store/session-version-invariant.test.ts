import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('phase 1019 r124 E fork: DialogStore version invariant', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let store: DialogStore;
  const filename = 'current.json';
  const clawId = 'test-claw';

  beforeEach(async () => {
    tempDir = await createTempDir();
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    store = new DialogStore(nodeFs, '', audit.audit, filename, clawId);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('rejects session.json with version > SESSION_CURRENT_VERSION and falls back to cold start', async () => {
    const badSession = {
      version: 999,
      clawId,
      createdAt: '2026-05-18T00:00:00Z',
      updatedAt: '2026-05-18T00:00:00Z',
      systemPrompt: '',
      messages: [],
      toolsForLLM: [],
    };
    await fs.writeFile(path.join(tempDir, filename), JSON.stringify(badSession), 'utf-8');

    const result = await store.load();

    // unknown version → treat as corrupt → fallback to cold start
    expect(result.source).toBe('empty');

    const unknownEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN);
    expect(unknownEvents.length).toBeGreaterThanOrEqual(1);
    expect(unknownEvents[0]).toEqual(
      expect.arrayContaining([
        DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN,
        expect.stringContaining('actual=999'),
        expect.stringContaining('current=2'),
      ]),
    );
  });

  it('v1 session (missing toolsForLLM) → migrate to v2 with audit emit VERSION_MIGRATE', async () => {
    const v1Session = {
      version: 1,
      clawId,
      createdAt: '2026-05-18T00:00:00Z',
      updatedAt: '2026-05-18T00:00:00Z',
      systemPrompt: 'v1 prompt',
      messages: [{ role: 'user' as const, content: 'hello' }],
      // toolsForLLM missing → v1 shape
    };
    await fs.writeFile(path.join(tempDir, filename), JSON.stringify(v1Session), 'utf-8');

    const result = await store.load();

    expect(result.source).toBe('current');
    expect(result.session.version).toBe(2);
    expect(result.session.toolsForLLM).toEqual([]);
    expect(result.session.systemPrompt).toBe('v1 prompt');

    const migrateEvents = audit.events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.VERSION_MIGRATE);
    expect(migrateEvents.length).toBe(1);
    expect(migrateEvents[0]).toEqual(
      expect.arrayContaining([
        DIALOG_AUDIT_EVENTS.VERSION_MIGRATE,
        expect.stringContaining('from=1'),
        expect.stringContaining('to=2'),
      ]),
    );
  });
});
