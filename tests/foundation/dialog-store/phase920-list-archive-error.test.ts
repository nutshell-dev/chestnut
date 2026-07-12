/**
 * Phase 920 Step B: listArchiveDialogFiles error propagation
 */
import { describe, it, expect, vi } from 'vitest';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { listArchiveDialogFiles } from '../../../src/foundation/dialog-store/list-archive.js';

function makeEaccesError(): Error {
  const err = new Error('EACCES: permission denied, scandir');
  (err as NodeJS.ErrnoException).code = 'EACCES';
  return err;
}

describe('listArchiveDialogFiles (phase 920)', () => {
  it('throws on EACCES instead of returning an empty list', async () => {
    const mockFs = {
      existsSync: vi.fn(() => true),
      list: vi.fn(async () => {
        throw makeEaccesError();
      }),
      stat: vi.fn(async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
    } as unknown as FileSystem;

    await expect(listArchiveDialogFiles(mockFs, '/any/claw')).rejects.toThrow('EACCES');
    expect(mockFs.list).toHaveBeenCalledTimes(1);
  });

  it('skips a file that vanished between list and stat (TOCTOU ENOENT)', async () => {
    const mockFs = {
      existsSync: vi.fn(() => true),
      list: vi.fn(async () => [
        { name: '1700000000_abc.json', path: 'dialog/archive/1700000000_abc.json', isFile: true, isDirectory: false, size: 10, mtime: new Date() },
        { name: 'gone.json', path: 'dialog/archive/gone.json', isFile: true, isDirectory: false, size: 10, mtime: new Date() },
      ]),
      stat: vi.fn(async (p: string) => {
        if (p.endsWith('gone.json')) {
          const err = new Error('ENOENT');
          (err as NodeJS.ErrnoException).code = 'ENOENT';
          throw err;
        }
        return { size: 10, mtime: new Date(1700000000000), ctime: new Date(), isFile: true, isDirectory: false };
      }),
    } as unknown as FileSystem;

    const refs = await listArchiveDialogFiles(mockFs, '/any/claw');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('1700000000_abc.json');
  });
});
