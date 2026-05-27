import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BatchedAuditWriter } from '../../../src/foundation/audit/batched-writer.js';
import { _resetFallbackForTest } from '../../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeFs(behavior: { appendThrows?: Error } = {}): FileSystem {
  const calls: { method: string; args: any[] }[] = [];
  const fs: any = {
    appendSync(...args: any[]) {
      calls.push({ method: 'appendSync', args });
      if (behavior.appendThrows) throw behavior.appendThrows;
    },
    syncSync() {},
    statSync() { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    moveSync() {},
  };
  fs.__calls = calls;
  return fs as FileSystem;
}

describe('BatchedAuditWriter fallback wiring', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetFallbackForTest();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetFallbackForTest();
  });

  it('flush failure → pushFallback per line + console.error + buffer not累涨', () => {
    const fs = makeFs({ appendThrows: new Error('disk full') });
    const writer = new BatchedAuditWriter(fs, '/tmp/audit.tsv', { batchSize: 2, flushIntervalMs: 60_000 });
    writer.write('evt_a', 'col1');
    writer.write('evt_b', 'col1');   // 触发 flush + fail
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('batched flush failed');
    // buffer should NOT contain re-queued lines (fallback took over)
    expect((writer as any).buffer.length).toBe(0);
    writer.dispose();
  });

  it('happy path → 0 fallback / 0 console.error', () => {
    const fs = makeFs();
    const writer = new BatchedAuditWriter(fs, '/tmp/audit.tsv', { batchSize: 2, flushIntervalMs: 60_000 });
    writer.write('evt_a', 'col1');
    writer.write('evt_b', 'col1');
    expect(errSpy).not.toHaveBeenCalled();
    expect((fs as any).__calls.filter((c: any) => c.method === 'appendSync').length).toBe(1);
    writer.dispose();
  });

  it('flush failure retry: subsequent successful write triggers flush of new batch only (fallback line owns failed batch)', () => {
    let throwsNext = true;
    const fs: any = {
      appendSync(...args: any[]) {
        if (throwsNext) { throwsNext = false; throw new Error('transient'); }
      },
      syncSync() {},
      statSync() { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
      moveSync() {},
    };
    const writer = new BatchedAuditWriter(fs as FileSystem, '/tmp/audit.tsv', { batchSize: 2, flushIntervalMs: 60_000 });
    writer.write('evt_a', 'col1');
    writer.write('evt_b', 'col1');   // batch1 fail → fallback take over
    writer.write('evt_c', 'col1');
    writer.write('evt_d', 'col1');   // batch2 success
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect((writer as any).buffer.length).toBe(0);
    writer.dispose();
  });
});
