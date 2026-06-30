import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import * as nodeOs from 'node:os';
import {
  createAuditReader,
  listAuditFiles,
  listPendingFallbackDumps,
} from '../../../src/foundation/audit/reader.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { waitFor } from '../../helpers/wait-for.js';

/**
 * Follow-mode append delay (50ms): 等 follow() iter 进入 wait 后再 append.
 * Derivation: > microtask flush / < FOLLOW_CLOSE_DEADLINE_MS / 让 follow loop 实际跑过一轮.
 */
const FOLLOW_APPEND_DELAY_MS = 50;

/**
 * Follow-mode test 总 deadline (400ms): hang fail-safe.
 * Derivation: >>> append delay (50ms) + iter callback budget / 不死等.
 */
const FOLLOW_CLOSE_DEADLINE_MS = 400;

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
    listSync: (p: string) => {
      const result: { name: string; path: string; isDirectory: boolean; isFile: boolean; size: number; mtime: Date }[] = [];
      for (const key of Object.keys(meta)) {
        const dir = path.dirname(key);
        if (dir === p) {
          result.push({
            name: path.basename(key),
            path: key,
            isDirectory: meta[key].isDirectory,
            isFile: !meta[key].isDirectory,
            size: meta[key].size,
            mtime: new Date(),
          });
        }
      }
      return result;
    },
  } as unknown as FileSystem;
}

/** Create a mutable mock fs suitable for follow tests. */
function makeMutableFs(initial: Record<string, string>): { fs: FileSystem; append: (p: string, data: string) => void; replace: (p: string, data: string) => void } {
  const store: Record<string, string> = { ...initial };
  const meta: Record<string, { size: number; isDirectory: boolean }> = {};
  for (const [k, v] of Object.entries(initial)) {
    meta[k] = { size: v.length, isDirectory: false };
  }
  const fs: FileSystem = {
    existsSync: (p: string) => p in store || p in meta,
    readSync: (p: string) => store[p] ?? '',
    statSync: (p: string) => ({
      size: meta[p]?.size ?? 0,
      mtime: new Date(),
      ctime: new Date(),
      isDirectory: () => meta[p]?.isDirectory ?? false,
      isFile: () => !meta[p]?.isDirectory,
    }),
    listSync: (p: string) => {
      const result: { name: string; path: string; isDirectory: boolean; isFile: boolean; size: number; mtime: Date }[] = [];
      for (const key of Object.keys(meta)) {
        const dir = path.dirname(key);
        if (dir === p) {
          result.push({
            name: path.basename(key),
            path: key,
            isDirectory: meta[key].isDirectory,
            isFile: !meta[key].isDirectory,
            size: meta[key].size,
            mtime: new Date(),
          });
        }
      }
      return result;
    },
  } as unknown as FileSystem;
  return {
    fs,
    append: (p: string, data: string) => {
      store[p] = (store[p] ?? '') + data;
      meta[p] = { size: store[p].length, isDirectory: false };
    },
    replace: (p: string, data: string) => {
      store[p] = data;
      meta[p] = { size: data.length, isDirectory: false };
    },
  };
}

describe('AuditReader', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('read', () => {
    it('returns empty for non-existent file', async () => {
      const fs = makeFs({});
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect(recs).toHaveLength(0);
    });

    it('reads single line', async () => {
      const fs = makeFs({ '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ttest_event\tcol1\tcol2\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ ts: '2024-01-01T00:00:00Z', seq: 1, type: 'test_event', cols: ['col1', 'col2'] });
    });

    it('reads multiple lines', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\ta\tcol1\n' +
          '2024-01-01T00:00:01Z\tseq=2\tb\tcol2\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect(recs).toHaveLength(2);
      expect((recs[1] as any).type).toBe('b');
    });

    it('filters by fromSeq', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\ta\n' +
          '2024-01-01T00:00:01Z\tseq=3\tb\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ fromSeq: 3 })) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).seq).toBe(3);
    });

    it('filters by toSeq', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\ta\n' +
          '2024-01-01T00:00:01Z\tseq=3\tb\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ toSeq: 1 })) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).seq).toBe(1);
    });

    it('filters by sinceTs', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\ta\n' +
          '2024-01-02T00:00:00Z\tseq=2\tb\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ sinceTs: '2024-01-02T00:00:00Z' })) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).type).toBe('b');
    });

    it('filters by untilTs', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\ta\n' +
          '2024-01-02T00:00:00Z\tseq=2\tb\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ untilTs: '2024-01-01T00:00:00Z' })) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).type).toBe('a');
    });

    it('filters by typePattern glob', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\tcron_tick\n' +
          '2024-01-01T00:00:01Z\tseq=2\tcron_tock\n' +
          '2024-01-01T00:00:02Z\tseq=3\tother\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ typePattern: 'cron_*' })) recs.push(rec);
      expect(recs).toHaveLength(2);
    });

    it('filters by traceId', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\ta\tcol1\ttrace_id=abc\n' +
          '2024-01-01T00:00:01Z\tseq=2\tb\tcol1\ttrace_id=def\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ traceId: 'abc' })) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).trace_id).toBe('abc');
    });

    it('filters by colFilter', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\ta\tk=v1\n' +
          '2024-01-01T00:00:01Z\tseq=2\tb\tk=v2\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ colFilter: { k: 'v1' } })) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).type).toBe('a');
    });

    it('limits results', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\ta\n' +
          '2024-01-01T00:00:01Z\tseq=2\tb\n' +
          '2024-01-01T00:00:02Z\tseq=3\tc\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ limit: 2 })) recs.push(rec);
      expect(recs).toHaveLength(2);
    });

    it('combines filters', async () => {
      const fs = makeFs({
        '/test/audit.tsv':
          '2024-01-01T00:00:00Z\tseq=1\tcron_a\n' +
          '2024-01-02T00:00:00Z\tseq=2\tcron_b\n' +
          '2024-01-03T00:00:00Z\tseq=3\tcron_c\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read({ typePattern: 'cron_*', fromSeq: 2, limit: 1 })) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).seq).toBe(2);
    });
  });

  describe('read malformed rows', () => {
    it('skips parts < 3 with stderr warn', async () => {
      const fs = makeFs({ '/test/audit.tsv': 'bad\n2024-01-01T00:00:00Z\tseq=1\tok\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).type).toBe('ok');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('malformed row skipped'));
    });

    it('skips missing seq= with stderr warn', async () => {
      const fs = makeFs({ '/test/audit.tsv': '2024-01-01T00:00:00Z\tbad\tok\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect(recs).toHaveLength(0);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('missing seq col'));
    });

    it('skips NaN seq with stderr warn', async () => {
      const fs = makeFs({ '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=bad\tok\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect(recs).toHaveLength(0);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('invalid seq'));
    });

    it('skips empty lines', async () => {
      const fs = makeFs({ '/test/audit.tsv': '\n\n2024-01-01T00:00:00Z\tseq=1\tok\n\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect(recs).toHaveLength(1);
    });

    it('handles escaped chars in cols', async () => {
      const fs = makeFs({ '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\tt\tcol\\twith\\ttab\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).cols[0]).toBe('col\twith\ttab');
    });
  });

  describe('trace_id parsing', () => {
    it('extracts trace_id from last col', async () => {
      const fs = makeFs({ '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ta\tcol1\ttrace_id=abc\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect((recs[0] as any).trace_id).toBe('abc');
      expect((recs[0] as any).cols).toEqual(['col1']);
    });

    it('leaves trace_id undefined when absent', async () => {
      const fs = makeFs({ '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ta\tcol1\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect((recs[0] as any).trace_id).toBeUndefined();
    });

    it('does not misparse trace_id= in middle col', async () => {
      const fs = makeFs({ '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ta\ttrace_id=notlast\tcol2\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const recs: unknown[] = [];
      for await (const rec of reader.read()) recs.push(rec);
      expect((recs[0] as any).trace_id).toBeUndefined();
      expect((recs[0] as any).cols).toEqual(['trace_id=notlast', 'col2']);
    });
  });

  describe('follow', () => {
    it('yields new appends after EOF', async () => {
      const { fs, append } = makeMutableFs({
        '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ta\n',
      });
      const reader = createAuditReader(fs, '/test/audit.tsv');

      const iter = reader.follow();
      // Append after a short delay
      setTimeout(() => {
        append('/test/audit.tsv', '2024-01-01T00:00:01Z\tseq=2\tb\n');
      }, FOLLOW_APPEND_DELAY_MS);

      const recs: unknown[] = [];
      const timeout = setTimeout(() => { reader.close(); }, FOLLOW_CLOSE_DEADLINE_MS);
      for await (const rec of iter) {
        recs.push(rec);
        if (recs.length >= 1) { reader.close(); break; }
      }
      clearTimeout(timeout);
      expect(recs).toHaveLength(1);
      expect((recs[0] as any).type).toBe('b');
    });

    it('close() stops follow', async () => {
      const { fs } = makeMutableFs({ '/test/audit.tsv': '2024-01-01T00:00:00Z\tseq=1\ta\n' });
      const reader = createAuditReader(fs, '/test/audit.tsv');
      const iter = reader.follow();
      reader.close();
      const recs: unknown[] = [];
      for await (const rec of iter) recs.push(rec);
      expect(recs).toHaveLength(0);
    });
  });

  describe('__brand invariant', () => {
    it('AuditReader has __brand', () => {
      const fs = makeFs({});
      const reader = createAuditReader(fs, '/test/audit.tsv');
      expect(reader.__brand).toBe('AuditReader');
    });
  });
});

describe('listAuditFiles', () => {
  it('returns empty for non-existent baseDir', () => {
    const fs = makeFs({});
    expect(listAuditFiles(fs, '/test')).toEqual([]);
  });

  it('returns empty for empty dir', () => {
    const fs = makeFs({ '/test': { size: 0, isDirectory: true } });
    expect(listAuditFiles(fs, '/test')).toEqual([]);
  });

  it('finds single audit.tsv', () => {
    const fs = makeFs({
      '/test': { size: 0, isDirectory: true },
      '/test/audit.tsv': 'content',
    });
    const files = listAuditFiles(fs, '/test');
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('audit');
    expect(files[0].isBusinessMain).toBe(true);
  });

  it('finds multiple .tsv files sorted', () => {
    const fs = makeFs({
      '/test': { size: 0, isDirectory: true },
      '/test/tick.tsv': 'c',
      '/test/audit.tsv': 'c',
    });
    const files = listAuditFiles(fs, '/test');
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe('audit');
    expect(files[1].name).toBe('tick');
  });

  it('excludes .bak files', () => {
    const fs = makeFs({
      '/test': { size: 0, isDirectory: true },
      '/test/audit.tsv': 'c',
      '/test/audit.tsv.bak': 'c',
    });
    const files = listAuditFiles(fs, '/test');
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('audit');
  });
});

describe('listPendingFallbackDumps', () => {
  let createdFiles: string[] = [];

  afterEach(() => {
    for (const f of createdFiles) {
      try { nodeFs.unlinkSync(f); } catch { /* ignore */ }
    }
    createdFiles = [];
  });

  it('returns empty when no matching files', () => {
    expect(listPendingFallbackDumps()).toEqual([]);
  });

  it('returns matching fallback dumps', async () => {
    const dumpPath = path.join(nodeOs.tmpdir(), 'chestnut-audit-fallback-1234-5678.tsv');
    nodeFs.writeFileSync(dumpPath, 'line1\n');
    createdFiles.push(dumpPath);
    // phase 779 Step D: waitFor 替即时 assertion — tmpdir 跨 worker 共享、并发下其他
    // worker 的 afterEach unlinkSync 可能在 writeFileSync 后、readdirSync 前删文件。
    // writeFileSync + readdirSync 皆同步但跨进程 OS 调度无保证。
    await waitFor(() => {
      const dumps = listPendingFallbackDumps();
      return dumps.some(d => d.pid === 1234 && d.ts === 5678);
    }, 5000);
    const dumps = listPendingFallbackDumps();
    expect(dumps.some(d => d.pid === 1234 && d.ts === 5678)).toBe(true);
  });

  it('ignores non-matching files', () => {
    const otherPath = path.join(nodeOs.tmpdir(), 'other-file.tsv');
    nodeFs.writeFileSync(otherPath, 'x');
    createdFiles.push(otherPath);
    expect(listPendingFallbackDumps()).toEqual([]);
  });
});
