import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Snapshot } from '../../../src/foundation/snapshot/snapshot.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { makeMockAudit } from '../../helpers/audit.js';

// Helper to build a minimal mock FileSystem
function makeMockFs(): FileSystem {
  return {
    exists: vi.fn(() => Promise.resolve(true)),
    read: vi.fn(() => Promise.resolve('')),
    writeAtomic: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    removeDir: vi.fn(() => Promise.resolve()),
    ensureDir: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve([])),
    realpath: vi.fn((p: string) => Promise.resolve(p)),
    appendSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
    moveSync: vi.fn(),
    existsSync: vi.fn(() => true),
    listSync: vi.fn(() => []),
    readSync: vi.fn(() => ''),
    writeAtomicSync: vi.fn(),
    ensureDirSync: vi.fn(),
    deleteSync: vi.fn(),
  } as unknown as FileSystem;
}

const mockAudit = makeMockAudit();

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(() => Promise.resolve({ output: '' })),
}));

describe('Snapshot commit throttle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('反向 1: rapid commits within 30s — second skipped', async () => {
    const fs = makeMockFs();
    const snapshot = new Snapshot('/tmp/agent', fs, mockAudit, [], undefined, mockExec);

    vi.clearAllMocks();
    mockExec
      .mockResolvedValueOnce({ output: ' M file.ts\n' }) // status
      .mockResolvedValueOnce({ output: '' })              // add
      .mockResolvedValueOnce({ output: '' });             // commit

    const r1 = await snapshot.commit('turn-1');
    expect(r1.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(3);

    // Second commit immediately — should be throttled
    const r2 = await snapshot.commit('turn-2');
    expect(r2.ok).toBe(true);
    // No additional git calls because throttle kicks in
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it('反向 2: commit after 30s+ gap proceeds', async () => {
    const fs = makeMockFs();
    const snapshot = new Snapshot('/tmp/agent2', fs, mockAudit, [], undefined, mockExec);

    vi.clearAllMocks();
    mockExec
      .mockResolvedValueOnce({ output: ' M file.ts\n' })
      .mockResolvedValueOnce({ output: '' })
      .mockResolvedValueOnce({ output: '' });

    const r1 = await snapshot.commit('turn-a');
    expect(r1.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(3);

    // Simulate time passing beyond throttle window
    // We need to mutate _lastCommitMs. It's private, so we use a hack.
    (snapshot as any)._lastCommitMs = Date.now() - 31_000;

    vi.clearAllMocks();
    mockExec
      .mockResolvedValueOnce({ output: ' M file2.ts\n' })
      .mockResolvedValueOnce({ output: '' })
      .mockResolvedValueOnce({ output: '' });

    const r2 = await snapshot.commit('turn-b');
    expect(r2.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(3);
  });
});
