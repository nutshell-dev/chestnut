/**
 * Phase 858: lightweight-query Result semantics.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  peekPendingCount,
  peekPendingFilenames,
} from '../../../src/foundation/messaging/lightweight-query.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

function makeFs(opts: {
  exists?: boolean;
  listError?: NodeJS.ErrnoException;
  entries?: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
}): FileSystem {
  return {
    existsSync: vi.fn(() => opts.exists ?? true),
    listSync: vi.fn(() => {
      if (opts.listError) throw opts.listError;
      return opts.entries ?? [];
    }),
  } as unknown as FileSystem;
}

describe('lightweight-query Result (phase 858)', () => {
  it('peekPendingCount returns ok 0 when pending dir does not exist', () => {
    const fs = makeFs({ exists: false });
    const result = peekPendingCount(fs, '.');
    expect(result).toEqual({ ok: true, value: 0 });
  });

  it('peekPendingCount returns ok count of .md files', () => {
    const fs = makeFs({
      entries: [
        { name: 'a.md', isDirectory: () => false, isFile: () => true },
        { name: 'b.md', isDirectory: () => false, isFile: () => true },
        { name: 'c.json', isDirectory: () => false, isFile: () => true },
      ],
    });
    const result = peekPendingCount(fs, '.');
    expect(result).toEqual({ ok: true, value: 2 });
  });

  it('peekPendingCount returns error when listSync throws', () => {
    const fs = makeFs({
      listError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const result = peekPendingCount(fs, '.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('EIO');
    }
  });

  it('peekPendingFilenames returns ok [] when pending dir does not exist', () => {
    const fs = makeFs({ exists: false });
    const result = peekPendingFilenames(fs, '.');
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('peekPendingFilenames returns ok .md filenames', () => {
    const fs = makeFs({
      entries: [
        { name: 'a.md', isDirectory: () => false, isFile: () => true },
        { name: 'b.txt', isDirectory: () => false, isFile: () => true },
      ],
    });
    const result = peekPendingFilenames(fs, '.');
    expect(result).toEqual({ ok: true, value: ['a.md'] });
  });

  it('peekPendingFilenames returns error when listSync throws', () => {
    const fs = makeFs({
      listError: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    });
    const result = peekPendingFilenames(fs, '.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('EACCES');
    }
  });
});
