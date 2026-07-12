/**
 * Phase 920 Step B: archive serialization + state reset
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('DialogStore archive (phase 920)', () => {
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

  it('archive waits for pending save before moving', async () => {
    const originalWrite = fs.writeAtomic.bind(fs);
    const originalMove = fs.move.bind(fs);
    const order: string[] = [];

    let releaseSave!: () => void;
    let saveEntered = false;

    vi.spyOn(fs, 'writeAtomic').mockImplementation(async (filePath, content) => {
      saveEntered = true;
      order.push('save');
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      return originalWrite(filePath, content);
    });

    vi.spyOn(fs, 'move').mockImplementation(async (fromPath, toPath) => {
      order.push('archive');
      return originalMove(fromPath, toPath);
    });

    const savePromise = store.save({
      systemPrompt: 'during-save',
      messages: [{ role: 'user', content: 'hello' }],
      toolsForLLM: [],
    });

    // Ensure save has entered its serialized write before we call archive.
    await vi.waitUntil(() => saveEntered, { timeout: 1000 });

    const archivePromise = store.archive();

    // Give archive a chance to run if it were not properly serialized.
    const ARCHIVE_RACE_WINDOW_MS = 30; // derive: short enough for test speed, long enough for racy archive to execute
    await new Promise((resolve) => setTimeout(resolve, ARCHIVE_RACE_WINDOW_MS));
    expect(order).toEqual(['save']);

    releaseSave();
    await Promise.all([savePromise, archivePromise]);

    expect(order).toEqual(['save', 'archive']);

    // After archive, current.json must be gone (no duplicate left behind).
    const hasCurrent = await store.hasCurrent();
    expect(hasCurrent).toBe(false);

    // And exactly one archive file should exist.
    const archives = await store.listArchives();
    expect(archives).toHaveLength(1);
  });

  it('resets prevMessagesLength after archive', async () => {
    // Create current.json so archive() can move it.
    await store.save({
      systemPrompt: 'pre-archive',
      messages: [{ role: 'user', content: 'msg' }],
      toolsForLLM: [],
    });

    // Simulate stale length cache from a previous long session.
    (store as any).prevMessagesLength = 500;

    await store.archive();

    expect((store as any).prevMessagesLength).toBe(0);
  });
});
