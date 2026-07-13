/**
 * Phase 878: schedule() writeAtomic failure must not leave a dangling index entry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeMockAudit(): AuditLog {
  return {
    write: vi.fn(),
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
}

describe('phase 878: schedule writeAtomic failure index consistency', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let shortIdIndex: InMemoryShortIdIndex;
  let addSpy: ReturnType<typeof vi.spyOn>;
  let saveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shortIdIndex = new InMemoryShortIdIndex();
    addSpy = vi.spyOn(shortIdIndex, 'add');
    saveSpy = vi.spyOn(shortIdIndex, 'save');

    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      existsSync: vi.fn().mockReturnValue(false),
      listSync: vi.fn().mockReturnValue([]),
      exists: vi.fn().mockResolvedValue(false),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as FileSystem;

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex,
      auditWriter: makeMockAudit(),
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    addSpy.mockRestore();
    saveSpy.mockRestore();
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('does not leave dangling index entry when task file write fails', async () => {
    await system.initialize();

    // initialize() legitimately saves the index after migration; clear before schedule.
    addSpy.mockClear();
    saveSpy.mockClear();

    await expect(
      system.schedule('subagent', {
        parentClawId: 'claw-1',
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        parentClawDir: '/tmp/claw',
        goal: 'test goal',
        maxSteps: 10,
      } as any),
    ).rejects.toThrow('disk full');

    // Index must not have been touched because writeAtomic failed.
    expect(addSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();

    // No registered shortId in the index
    const registered = Array.from((shortIdIndex as any).map?.keys?.() ?? []);
    expect(registered.length).toBe(0);
  });
});
