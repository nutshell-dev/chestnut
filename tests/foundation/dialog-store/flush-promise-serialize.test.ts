/**
 * DialogStore concurrent save() serialize via flushPromise chain (phase 1024 G.2)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

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
      await new Promise((r) => setTimeout(r, 20)); // simulate slow write
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

    await new Promise((r) => setTimeout(r, 10));
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
