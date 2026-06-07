/**
 * Phase 183 Step A: audit reader backward observation silent skip invariant
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAuditReader } from '../../../src/foundation/audit/reader.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeFs(entries: Record<string, string | { size: number; isDirectory?: boolean }>): FileSystem {
  const store: Record<string, string> = {};
  const meta: Record<string, { size: number; isDirectory: boolean }> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (typeof v === 'string') {
      store[k] = v;
      meta[k] = { size: v.length, isDirectory: false };
    } else {
      meta[k] = { size: v.size, isDirectory: v.isDirectory ?? false };
    }
  }
  return {
    existsSync: (p: string) => p in store || p in meta,
    readSync: (p: string) => store[p] ?? '',
    statSync: (p: string) => ({
      size: meta[p]?.size ?? 0,
      mtime: new Date(),
      ctime: new Date(),
      isDirectory: () => meta[p]?.isDirectory ?? false,
      isFile: () => !meta[p]?.isDirectory,
    }),
    listSync: () => [],
  } as unknown as FileSystem;
}

describe('audit reader backward observation silent skip (phase 183 Step A)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('历史 step=enum row 静默跳过 / stepNumber undefined / record 仍返回', async () => {
    const fs = makeFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tstep=empty_result\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(1);
    const r = recs[0] as any;
    expect(r.stepNumber).toBeUndefined();
    expect(r.cols).toContain('step=empty_result');
    const stepWarnings = stderrSpy.mock.calls.filter(
      (c: any) => typeof c[0] === 'string' && c[0].includes('invalid step value')
    );
    expect(stepWarnings).toHaveLength(0);
  });

  it('历史 step=complete / step=report / step=gc_failed 全静默跳过', async () => {
    const fs = makeFs({
      '/test/audit.tsv':
        '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tstep=complete\n' +
        '2024-01-01T00:00:01Z\tseq=2\ttool_emit\tstep=report\n' +
        '2024-01-01T00:00:02Z\tseq=3\ttool_emit\tstep=gc_failed\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(3);
    expect((recs[0] as any).stepNumber).toBeUndefined();
    expect((recs[1] as any).stepNumber).toBeUndefined();
    expect((recs[2] as any).stepNumber).toBeUndefined();
    const stepWarnings = stderrSpy.mock.calls.filter(
      (c: any) => typeof c[0] === 'string' && c[0].includes('invalid step value')
    );
    expect(stepWarnings).toHaveLength(0);
  });

  it('content_size=<word> row 静默跳过 / contentSize undefined / record 仍返回', async () => {
    const fs = makeFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tcontent_size=invalid\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(1);
    const r = recs[0] as any;
    expect(r.contentSize).toBeUndefined();
    expect(r.cols).toContain('content_size=invalid');
    const sizeWarnings = stderrSpy.mock.calls.filter(
      (c: any) => typeof c[0] === 'string' && c[0].includes('invalid content_size value')
    );
    expect(sizeWarnings).toHaveLength(0);
  });

  it('合法 step=<integer> row 仍 parse 正确 / stepNumber === parsed', async () => {
    const fs = makeFs({
      '/test/audit.tsv':
        '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tstep=1\n' +
        '2024-01-01T00:00:01Z\tseq=2\ttool_emit\tstep=42\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(2);
    expect((recs[0] as any).stepNumber).toBe(1);
    expect((recs[1] as any).stepNumber).toBe(42);
  });

  it('filter --step N 跳过历史 step=enum row（matchesOpts 不 match）', async () => {
    const fs = makeFs({
      '/test/audit.tsv':
        '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tstep=1\n' +
        '2024-01-01T00:00:01Z\tseq=2\ttool_emit\tstep=empty_result\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ stepNumber: 1 })) recs.push(rec);
    expect(recs).toHaveLength(1);
    expect((recs[0] as any).seq).toBe(1);
    expect((recs[0] as any).stepNumber).toBe(1);
  });

  it('reader.ts:283 invalid seq stderr 仍触发（不可预期失败保暴露、out of phase 183 scope）', async () => {
    const fs = makeFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=NOTANUMBER\ttool_emit\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid seq')
    );
  });
});
