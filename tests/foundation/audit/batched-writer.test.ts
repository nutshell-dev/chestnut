import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchedAuditWriter } from '../../../src/foundation/audit/batched-writer.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFs(): { fs: FileSystem; writes: string[] } {
  const writes: string[] = [];
  return {
    fs: {
      appendSync: vi.fn((_path: string, content: string) => { writes.push(content); }),
      statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
      moveSync: vi.fn(),
      existsSync: vi.fn(() => false),
      listSync: vi.fn(() => []),
      readSync: vi.fn(() => ''),
      writeAtomicSync: vi.fn(),
      ensureDirSync: vi.fn(),
      deleteSync: vi.fn(),
      syncSync: vi.fn(),
    } as unknown as FileSystem,
    writes,
  };
}

function makeMockFsWithAppendFailure(initialFailCount = 1): { fs: FileSystem; writes: string[]; failCount: { value: number } } {
  const writes: string[] = [];
  const failCount = { value: initialFailCount };
  return {
    fs: {
      appendSync: vi.fn((_path: string, content: string) => {
        if (failCount.value > 0) {
          failCount.value--;
          throw new Error('disk full');
        }
        writes.push(content);
      }),
      statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
      moveSync: vi.fn(),
      existsSync: vi.fn(() => false),
      listSync: vi.fn(() => []),
      readSync: vi.fn(() => ''),
      writeAtomicSync: vi.fn(),
      ensureDirSync: vi.fn(),
      deleteSync: vi.fn(),
      syncSync: vi.fn(),
    } as unknown as FileSystem,
    writes,
    failCount,
  };
}

describe('BatchedAuditWriter', () => {
  let writer: BatchedAuditWriter;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    writer?.dispose();
  });

  it('反向 1: buffer accumulates, flush on threshold (batchSize=3)', () => {
    const { fs, writes } = makeMockFs();
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { batchSize: 3, flushIntervalMs: 60_000 });

    writer.write('event_a', 'k=v');
    writer.write('event_b', 'k=v');
    // 2 writes — not yet flushed
    expect(writes.length).toBe(0);

    writer.write('event_c', 'k=v');
    // 3rd write — flush triggered
    expect(writes.length).toBe(1);
    const flushed = writes[0];
    expect(flushed.split('\n').filter(Boolean).length).toBe(3);
    expect(flushed).toContain('event_a');
    expect(flushed).toContain('event_b');
    expect(flushed).toContain('event_c');
  });

  it('反向 2: dispose() flushes remaining buffer', () => {
    const { fs, writes } = makeMockFs();
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { batchSize: 100, flushIntervalMs: 60_000 });

    writer.write('event_x', 'k=v');
    writer.write('event_y', 'k=v');
    expect(writes.length).toBe(0);

    writer.dispose();
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('event_x');
    expect(writes[0]).toContain('event_y');
  });

  it('反向 3: rotation on maxBytes exceeded', () => {
    const { fs, writes } = makeMockFs();
    (fs.statSync as any).mockReturnValue({ size: 10 * 1024 * 1024 }); // 10MB
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { maxSizeMb: 5, batchSize: 1 });

    writer.write('event_z', 'k=v');
    expect(fs.moveSync).toHaveBeenCalled();
    expect(writes.length).toBe(1);
  });

  it('H1: flush failure → fallback takes over, buffer cleared, new writes flush independently', () => {
    const { fs, writes, failCount } = makeMockFsWithAppendFailure();
    // batchSize large to avoid auto-flush on write; we manually control flush
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { batchSize: 100, flushIntervalMs: 60_000 });

    writer.write('event_a', 'k=v');
    writer.write('event_b', 'k=v');
    writer.write('event_c', 'k=v');
    // no auto-flush yet (buffer=3 < 100)
    expect(writes.length).toBe(0);

    // manual flush — fails, buffer cleared (fallback queue takes over)
    writer.flush();
    expect(writes.length).toBe(0);
    expect(failCount.value).toBe(0);
    expect((writer as any).buffer.length).toBe(0);

    // new writes — flush succeeds with new batch only (failed batch owned by fallback)
    writer.write('event_d', 'k=v');
    writer.write('event_e', 'k=v');
    writer.write('event_f', 'k=v');
    writer.flush();
    expect(writes.length).toBe(1);
    const flushed = writes[0];
    expect(flushed).toContain('event_d');
    expect(flushed).toContain('event_e');
    expect(flushed).toContain('event_f');
    expect(flushed).not.toContain('event_a');
  });

  it('MEDIUM: rotation non-ENOENT error logs to console.error', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fs, writes } = makeMockFs();
    (fs.statSync as any).mockImplementation(() => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { maxSizeMb: 5, batchSize: 1 });

    writer.write('event_z', 'k=v');
    expect(writes.length).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith('Audit rotation failed:', expect.any(Error));
    consoleSpy.mockRestore();
  });
});
