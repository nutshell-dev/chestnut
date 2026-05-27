/**
 * Phase 1152 G.3: BatchedAuditWriter flush exponential backoff reverse tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchedAuditWriter } from '../../../src/foundation/audit/batched-writer.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFsWithControllableAppend(
  opts: { failCount?: number; failForever?: boolean } = {},
): { fs: FileSystem; writes: string[]; failCount: { value: number } } {
  const writes: string[] = [];
  const failCount = { value: opts.failCount ?? 0 };
  return {
    fs: {
      appendSync: vi.fn((_path: string, content: string) => {
        if (opts.failForever || failCount.value > 0) {
          if (!opts.failForever) failCount.value--;
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

describe('BatchedAuditWriter flush backoff (phase 1152 G.3)', () => {
  let writer: BatchedAuditWriter;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    writer?.dispose();
  });

  it('反向 1: consecutive flush success → currentIntervalMs stays at flushIntervalMs', () => {
    const { fs } = makeMockFsWithControllableAppend();
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { batchSize: 1, flushIntervalMs: 1000 });

    writer.write('event_a', 'k=v');
    writer.write('event_b', 'k=v');

    expect((writer as any).currentIntervalMs).toBe(1000);
  });

  it('反向 2: flush failure → currentIntervalMs doubles up to max 30s', () => {
    const { fs } = makeMockFsWithControllableAppend({ failForever: true });
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { batchSize: 100, flushIntervalMs: 1000 });

    // Force manual flush failures (buffer must be non-empty for flush to attempt)
    writer.write('event_a', 'k=v');
    writer.flush(); // 1st fail → 1000*2 = 2000
    expect((writer as any).currentIntervalMs).toBe(2000);

    writer.write('event_b', 'k=v');
    writer.flush(); // 2nd fail → 2000*2 = 4000
    expect((writer as any).currentIntervalMs).toBe(4000);

    writer.write('event_c', 'k=v');
    writer.flush(); // 3rd fail → 4000*2 = 8000
    expect((writer as any).currentIntervalMs).toBe(8000);

    writer.write('event_d', 'k=v');
    writer.flush(); // 4th fail → 8000*2 = 16000
    expect((writer as any).currentIntervalMs).toBe(16000);

    writer.write('event_e', 'k=v');
    writer.flush(); // 5th fail → 16000*2 = 32000 → cap 30000
    expect((writer as any).currentIntervalMs).toBe(30000);

    writer.write('event_f', 'k=v');
    writer.flush(); // 6th fail → stays 30000
    expect((writer as any).currentIntervalMs).toBe(30000);
  });

  it('反向 3: failure then success → currentIntervalMs resets to flushIntervalMs', () => {
    const { fs, failCount } = makeMockFsWithControllableAppend({ failCount: 2 });
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { batchSize: 100, flushIntervalMs: 1000 });

    writer.write('event_a', 'k=v');
    writer.flush(); // fail 1 → 2000
    expect((writer as any).currentIntervalMs).toBe(2000);

    writer.write('event_b', 'k=v');
    writer.flush(); // fail 2 → 4000
    expect((writer as any).currentIntervalMs).toBe(4000);

    writer.write('event_c', 'k=v');
    writer.flush(); // success → reset 1000
    expect((writer as any).currentIntervalMs).toBe(1000);
    expect(failCount.value).toBe(0);
  });

  it('反向 4: immediate flush by batchSize does not wait for backoff timer', () => {
    const { fs, failCount } = makeMockFsWithControllableAppend({ failCount: 1 });
    writer = new BatchedAuditWriter(fs, '/tmp/test.tsv', { batchSize: 2, flushIntervalMs: 1000 });

    writer.write('event_a', 'k=v');
    writer.write('event_b', 'k=v'); // reaches batchSize=2 → immediate flush (fails)
    expect(failCount.value).toBe(0); // fail consumed

    // currentIntervalMs should have backed off
    expect((writer as any).currentIntervalMs).toBe(2000); // 1000*2, capped below max

    // Next immediate flush by batchSize should still happen right away (not wait timer)
    writer.write('event_c', 'k=v');
    writer.write('event_d', 'k=v'); // reaches batchSize=2 → immediate flush (succeeds)
    expect((writer as any).currentIntervalMs).toBe(1000); // reset on success
  });
});
