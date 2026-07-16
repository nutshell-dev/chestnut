import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditReader } from '../../../src/foundation/audit/reader.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

/**
 * Phase 183 Step A: audit reader backward observation silent skip invariant
 */


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

/**
 * Phase 147 Step A: reader typed ID 字段 + ReadOptions filter 扩展 invariant tests
 */


function makeTypedIdFs(entries: Record<string, string | { size: number; isDirectory?: boolean }>): FileSystem {
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

describe('Phase 147 typed ID parsing', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses tool_use_id col into toolUseId', async () => {
    const fs = makeTypedIdFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttool_emit\ttool_use_id=call_01_abc\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(1);
    expect((recs[0] as any).toolUseId).toBe('call_01_abc');
  });

  it('parses step col into stepNumber', async () => {
    const fs = makeTypedIdFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tstep=5\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(1);
    expect((recs[0] as any).stepNumber).toBe(5);
  });

  it('parses all 4 ID cols + content_size into typed fields', async () => {
    const fs = makeTypedIdFs({
      '/test/audit.tsv':
        '2024-01-01T00:00:00Z\tseq=1\ttool_emit\t' +
        'tool_use_id=call_01_abc\tstep=3\tcontract_id=cid1\tsubtask_id=sid1\tcontent_size=128\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(1);
    const r = recs[0] as any;
    expect(r.toolUseId).toBe('call_01_abc');
    expect(r.stepNumber).toBe(3);
    expect(r.contractId).toBe('cid1');
    expect(r.subtaskId).toBe('sid1');
    expect(r.contentSize).toBe(128);
  });

  it('silently skips invalid step value (backward observation, phase 183)', async () => {
    const fs = makeTypedIdFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tstep=abc\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(1);
    expect((recs[0] as any).stepNumber).toBeUndefined();
    expect((recs[0] as any).cols).toContain('step=abc');
    const stepWarnings = stderrSpy.mock.calls.filter((c: any) =>
      typeof c[0] === 'string' && c[0].includes('invalid step value')
    );
    expect(stepWarnings).toHaveLength(0);
  });

  it('silently skips invalid content_size value (backward observation, phase 183)', async () => {
    const fs = makeTypedIdFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tcontent_size=xyz\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect(recs).toHaveLength(1);
    expect((recs[0] as any).contentSize).toBeUndefined();
    expect((recs[0] as any).cols).toContain('content_size=xyz');
    const sizeWarnings = stderrSpy.mock.calls.filter((c: any) =>
      typeof c[0] === 'string' && c[0].includes('invalid content_size value')
    );
    expect(sizeWarnings).toHaveLength(0);
  });

  it('leaves stepNumber undefined when step col absent', async () => {
    const fs = makeTypedIdFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttool_emit\ttool_use_id=call_01_abc\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    expect((recs[0] as any).stepNumber).toBeUndefined();
  });

  it('preserves unknown cols without affecting typed fields', async () => {
    const fs = makeTypedIdFs({
      '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttool_emit\tunknown_col=X\tstep=2\n',
    });
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read()) recs.push(rec);
    const r = recs[0] as any;
    expect(r.stepNumber).toBe(2);
    expect(r.cols).toContain('unknown_col=X');
  });
});

describe('Phase 147 typed filter', () => {
  function makeAuditFs() {
    return makeTypedIdFs({
      '/test/audit.tsv':
        '2024-01-01T00:00:00Z\tseq=1\ta\ttool_use_id=t1\tstep=1\tcontract_id=c1\tsubtask_id=s1\n' +
        '2024-01-01T00:00:01Z\tseq=2\tb\ttool_use_id=t2\tstep=2\tcontract_id=c2\tsubtask_id=s2\n' +
        '2024-01-01T00:00:02Z\tseq=3\tc\ttool_use_id=t1\tstep=2\tcontract_id=c1\tsubtask_id=s2\n',
    });
  }

  it('filters by toolUseId', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ toolUseId: 't1' })) recs.push(rec);
    expect(recs).toHaveLength(2);
    expect((recs[0] as any).seq).toBe(1);
    expect((recs[1] as any).seq).toBe(3);
  });

  it('filters by stepNumber', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ stepNumber: 2 })) recs.push(rec);
    expect(recs).toHaveLength(2);
    expect((recs[0] as any).seq).toBe(2);
    expect((recs[1] as any).seq).toBe(3);
  });

  it('filters by contractId', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ contractId: 'c1' })) recs.push(rec);
    expect(recs).toHaveLength(2);
  });

  it('filters by subtaskId', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ subtaskId: 's2' })) recs.push(rec);
    expect(recs).toHaveLength(2);
  });

  it('combines typed filters with AND semantics', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ toolUseId: 't1', stepNumber: 2 })) recs.push(rec);
    expect(recs).toHaveLength(1);
    expect((recs[0] as any).seq).toBe(3);
  });

  it('typed filter stepNumber equivalent to colFilter {step: "2"}', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');

    const typedRecs: unknown[] = [];
    for await (const rec of reader.read({ stepNumber: 2 })) typedRecs.push(rec);

    const colRecs: unknown[] = [];
    for await (const rec of reader.read({ colFilter: { step: '2' } })) colRecs.push(rec);

    expect(typedRecs.map((r: any) => r.seq)).toEqual(colRecs.map((r: any) => r.seq));
  });

  it('typed filter + colFilter together apply AND semantics', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ toolUseId: 't1', colFilter: { step: '2' } })) recs.push(rec);
    expect(recs).toHaveLength(1);
    expect((recs[0] as any).seq).toBe(3);
  });

  it('returns empty when typed filter does not match', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ toolUseId: 'nonexistent' })) recs.push(rec);
    expect(recs).toHaveLength(0);
  });

  it('typed filter works with limit', async () => {
    const fs = makeAuditFs();
    const reader = createAuditReader(fs, '/test/audit.tsv');
    const recs: unknown[] = [];
    for await (const rec of reader.read({ toolUseId: 't1', limit: 1 })) recs.push(rec);
    expect(recs).toHaveLength(1);
    expect((recs[0] as any).seq).toBe(1);
  });
});

