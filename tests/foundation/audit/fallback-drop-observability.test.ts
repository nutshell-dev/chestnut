import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

// Must mock before importing the module-under-test (hoisted by vitest)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
  };
});

import {
  AuditWriter,
  _resetFallbackForTest,
  reconcileFallbackDumps,
  FALLBACK_BUFFER_CAP,
} from '../../../src/foundation/audit/writer.js';

function makeFailingFs(): FileSystem {
  return {
    appendSync: vi.fn(() => { throw new Error('EIO disk full'); }),
    statSync: vi.fn(() => ({ size: 0 } as any)),
    moveSync: vi.fn(),
  } as any;
}

describe('audit fallback FIFO drop observability (phase 1380)', () => {
  let exitListeners: Array<() => void>;

  beforeEach(() => {
    _resetFallbackForTest();
    exitListeners = [];
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
      if (event === 'exit') exitListeners.push(handler);
      return process;
    });
    vi.mocked(nodeFs.writeFileSync).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(nodeFs.writeFileSync).mockClear();
  });

  it('drop counter accumulates across overflow events (total never resets)', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    // fill buffer + overflow 5
    for (let i = 0; i < FALLBACK_BUFFER_CAP + 5; i++) {
      writer.write('event', `i=${i}`);
    }

    exitListeners[0]!();
    expect(nodeFs.writeFileSync).toHaveBeenCalled();
    const dumpedContent = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    const allLines = dumpedContent.split('\n').filter(l => l.length > 0);
    expect(allLines[0]).toMatch(/^# drop_count_since_last_dump=5 drop_count_total=5 first_drop_ts=\d+ last_drop_ts=\d+$/);

    consoleErrSpy.mockRestore();
  });

  it('dump file frontmatter contains drop_count_since_last_dump + total + first/last ts', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    for (let i = 0; i < FALLBACK_BUFFER_CAP + 5; i++) {
      writer.write('event', `i=${i}`);
    }

    exitListeners[0]!();
    expect(nodeFs.writeFileSync).toHaveBeenCalled();
    const dumpedContent = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    const allLines = dumpedContent.split('\n').filter(l => l.length > 0);
    expect(allLines[0]).toMatch(/^# drop_count_since_last_dump=/);

    const fmMatch = allLines[0].match(/^# drop_count_since_last_dump=(\d+) drop_count_total=(\d+) first_drop_ts=(\d+) last_drop_ts=(\d+)$/);
    expect(fmMatch).not.toBeNull();
    const [, since, total, firstTs, lastTs] = fmMatch!;
    expect(Number(since)).toBe(5);
    expect(Number(total)).toBe(5);
    expect(Number(firstTs)).toBeGreaterThan(0);
    expect(Number(lastTs)).toBeGreaterThanOrEqual(Number(firstTs));

    consoleErrSpy.mockRestore();
  });

  it('reconcileFallbackDumps emits audit_fallback_dropped row to live audit.tsv', async () => {
    const dumpFileName = `chestnut-audit-fallback-123-456.tsv`;
    const dumpContent = [
      '# drop_count_since_last_dump=3 drop_count_total=8 first_drop_ts=1000 last_drop_ts=2000',
      '/test/a.tsv\t2026-05-18T10:00:00.000Z\tevt_a\tcol1',
      '/test/b.tsv\t2026-05-18T10:00:01.000Z\tevt_b\tcol2',
      '/test/a.tsv\t2026-05-18T10:00:02.000Z\tevt_a2\tcol3',
    ].join('\n') + '\n';

    const appended = new Map<string, string>();
    let deletedPath: string | null = null;
    const mockFs: FileSystem = {
      list: vi.fn(async (_path: string, _opts?: any) => {
        return [{ name: dumpFileName, path: dumpFileName, isDirectory: false, isFile: true, size: dumpContent.length }];
      }),
      read: vi.fn(async (_path: string) => {
        return dumpContent;
      }),
      appendSync: vi.fn((origin: string, content: string) => {
        appended.set(origin, (appended.get(origin) || '') + content);
      }),
      delete: vi.fn(async (path: string) => {
        deletedPath = path;
      }),
    } as any;

    await reconcileFallbackDumps(mockFs);

    expect(appended.has('/test/a.tsv')).toBe(true);
    expect(appended.has('/test/b.tsv')).toBe(true);

    const aContent = appended.get('/test/a.tsv')!;
    expect(aContent).toContain('audit_fallback_dropped');
    expect(aContent).toContain('drop_count=3');
    expect(aContent).toContain('drop_count_total=8');
    expect(aContent).toContain('first_drop_ts=1000');
    expect(aContent).toContain('last_drop_ts=2000');

    const bContent = appended.get('/test/b.tsv')!;
    expect(bContent).toContain('audit_fallback_dropped');
    expect(bContent).toContain('drop_count=3');

    expect(deletedPath).not.toBeNull();
    expect(deletedPath).toContain(dumpFileName);
  });

  it('dropCountSinceLastDump resets after successful dump, total never resets', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    // first overflow 5
    for (let i = 0; i < FALLBACK_BUFFER_CAP + 5; i++) {
      writer.write('event', `i=${i}`);
    }
    exitListeners[0]!();
    const firstDump = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    const firstLines = firstDump.split('\n').filter(l => l.length > 0);
    expect(firstLines[0]).toMatch(/^# drop_count_since_last_dump=5 drop_count_total=5/);

    vi.mocked(nodeFs.writeFileSync).mockClear();

    // second overflow 3 more (total should be 8)
    // After first dump, pendingFallback is empty. Fill again and overflow 3.
    for (let i = 0; i < FALLBACK_BUFFER_CAP + 3; i++) {
      writer.write('event', `second=${i}`);
    }
    writer.dispose();
    const secondDump = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    const secondLines = secondDump.split('\n').filter(l => l.length > 0);
    expect(secondLines[0]).toMatch(/^# drop_count_since_last_dump=3 drop_count_total=8/);

    consoleErrSpy.mockRestore();
  });
});
