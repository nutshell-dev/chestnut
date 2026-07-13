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
} from '../../../src/foundation/audit/writer.js';

function makeFailingFs(): FileSystem {
  return {
    appendSync: vi.fn(() => { throw new Error('EIO disk full'); }),
    statSync: vi.fn(() => ({ size: 0 } as any)),
    moveSync: vi.fn(),
  } as any;
}

describe('fallback periodic flush and reconcile', () => {
  beforeEach(() => {
    _resetFallbackForTest();
    vi.mocked(nodeFs.writeFileSync).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('periodic flush dumps and clears buffer after 5s', () => {
    vi.useFakeTimers();
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    writer.write('evt1', 'col1');
    writer.write('evt2', 'col2');

    // Before timer fires, nothing dumped
    expect(vi.mocked(nodeFs.writeFileSync)).not.toHaveBeenCalled();

    // Advance 5s → periodic flush fires
    vi.advanceTimersByTime(5000);
    expect(vi.mocked(nodeFs.writeFileSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(nodeFs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringMatching(/^.*chestnut-audit-fallback-\d+-\d+\.tsv$/),
      expect.stringContaining('evt1'),
    );
    const dumpedContent = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    expect(dumpedContent).toContain('evt1');
    expect(dumpedContent).toContain('evt2');

    // Advance another 5s → buffer already cleared → no new dump
    vi.advanceTimersByTime(5000);
    expect(vi.mocked(nodeFs.writeFileSync)).toHaveBeenCalledTimes(1);

    consoleErrSpy.mockRestore();
  });

  it('dump-clear atomic — write fail restores entries via unshift', () => {
    vi.useFakeTimers();
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(nodeFs.writeFileSync).mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    writer.write('evt1', 'col1');
    writer.write('evt2', 'col2');

    // Advance 5s → periodic flush fires but write fails
    vi.advanceTimersByTime(5000);
    expect(vi.mocked(nodeFs.writeFileSync)).toHaveBeenCalledTimes(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[AUDIT CRITICAL\] fallback dump failed: reason=ENOSPC/),
    );

    // A second timer tick should re-attempt with the same entries
    vi.advanceTimersByTime(5000);
    expect(vi.mocked(nodeFs.writeFileSync)).toHaveBeenCalledTimes(2);
    // Both calls should contain the same data (restored entries)
    const firstCall = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    const secondCall = (vi.mocked(nodeFs.writeFileSync).mock.calls[1] as any)[1] as string;
    expect(firstCall).toContain('evt1');
    expect(secondCall).toContain('evt1');

    consoleErrSpy.mockRestore();
  });

  it('reconcileFallbackDumps recovers prior crash dump and deletes it', async () => {
    const dumpFileName = `chestnut-audit-fallback-${process.pid}-${Date.now()}.tsv`;

    // Write a fake crash dump with 2 origins
    const dumpContent = [
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

    // Verify list was called
    expect(mockFs.list).toHaveBeenCalled();

    // Verify both origins got appended
    expect(appended.has('/test/a.tsv')).toBe(true);
    expect(appended.has('/test/b.tsv')).toBe(true);

    const aContent = appended.get('/test/a.tsv')!;
    expect(aContent).toContain('evt_a');
    expect(aContent).toContain('evt_a2');

    const bContent = appended.get('/test/b.tsv')!;
    expect(bContent).toContain('evt_b');

    // Verify dump file deleted
    expect(deletedPath).not.toBeNull();
    expect(deletedPath).toContain(dumpFileName);
  });
});
