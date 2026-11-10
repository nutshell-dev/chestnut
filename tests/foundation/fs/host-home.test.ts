import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const mockHomedir = vi.hoisted(() => vi.fn<() => string>());

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: mockHomedir,
}));

import { getHostHomeDirectory } from '../../../src/foundation/fs/index.js';

describe('getHostHomeDirectory', () => {
  beforeEach(() => {
    mockHomedir.mockReset();
  });

  afterEach(() => {
    mockHomedir.mockReset();
  });

  it('returns an absolute path with spaces and Unicode unchanged', () => {
    const home = path.resolve(path.sep, '宿主 home', '用户');
    mockHomedir.mockReturnValue(home);

    expect(getHostHomeDirectory()).toBe(home);
  });

  it.each(['', path.join('relative', 'home')])('rejects an empty or relative home directory: %j', (home) => {
    mockHomedir.mockReturnValue(home);

    expect(() => getHostHomeDirectory()).toThrow('Host home directory is unavailable');
  });

  it('preserves the original OS exception object', () => {
    const failure = new Error('host home lookup failed');
    mockHomedir.mockImplementation(() => {
      throw failure;
    });

    try {
      getHostHomeDirectory();
      expect.unreachable('expected the OS exception to propagate');
    } catch (error) {
      expect(error).toBe(failure);
    }
  });
});
