import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import type { FileSystem } from '../../src/foundation/fs/index.js';

const mockGetHostHomeDirectory = vi.hoisted(() => vi.fn<() => string>());

vi.mock('../../src/foundation/fs/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/fs/index.js')>()),
  getHostHomeDirectory: mockGetHostHomeDirectory,
}));

import { initCommand } from '../../src/cli/commands/motion.js';

describe('motion init host home directory', () => {
  beforeEach(() => {
    mockGetHostHomeDirectory.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetHostHomeDirectory.mockReset();
  });

  it('propagates host home lookup failure without calling fsFactory', async () => {
    const failure = new Error('host home lookup failed');
    mockGetHostHomeDirectory.mockImplementation(() => {
      throw failure;
    });
    const fsFactory = vi.fn((_baseDir: string): FileSystem => {
      throw new Error('fsFactory must not be called');
    });

    await expect(initCommand({ fsFactory }, true)).rejects.toBe(failure);
    expect(fsFactory).not.toHaveBeenCalled();
  });

  it('creates claws under the host home instead of the cwd fallback', async () => {
    const hostHome = path.resolve(path.sep, '宿主 home', '用户');
    const templateSentinel = new Error('template read sentinel');
    const createdDirs: string[] = [];
    const readSync = vi.fn((_path: string): string => {
      throw templateSentinel;
    });
    const fsFactory = vi.fn((baseDir: string): FileSystem => ({
      ensureDir: vi.fn(async () => {
        createdDirs.push(baseDir);
      }),
      readSync,
    }) as unknown as FileSystem);
    mockGetHostHomeDirectory.mockReturnValue(hostHome);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(initCommand({ fsFactory }, true)).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('Failed to process templates:'),
    });

    expect(readSync).toHaveBeenCalled();
    expect(createdDirs).toContain(path.join(hostHome, '.chestnut', 'claws'));
    expect(createdDirs).not.toContain(path.join(process.cwd(), '.chestnut', 'claws'));
  });
});
