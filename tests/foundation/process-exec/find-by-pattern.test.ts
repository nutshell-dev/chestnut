/**
 * findByPattern tests
 *
 * Covers degraded behaviour when the `ps` companion command fails.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { findByPattern } from '../../../src/foundation/process-exec/find-by-pattern.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

describe('findByPattern', () => {
  it('writes stderr when ps fails with non-ENOENT', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const mockSpawnSync = vi.mocked(spawnSync);
    mockSpawnSync.mockReturnValueOnce({
      stdout: '42\n',
      stderr: '',
      status: 0,
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);
    mockSpawnSync.mockImplementation(() => {
      throw Object.assign(new Error('Input/output error'), { code: 'EIO' });
    });

    const result = findByPattern('node');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[process-exec] ps failed'));
    expect(result).toEqual([{ pid: 42, command: '' }]);
  });
});
