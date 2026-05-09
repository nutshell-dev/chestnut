import { describe, it, expect } from 'vitest';
import { findOrphanProcesses } from '../../src/cli/commands/status.js';
import { ProcessListUnavailable } from '../../src/foundation/process-manager/index.js';

describe('findOrphanProcesses', () => {
  it('returns empty array on ProcessListUnavailable (graceful skip)', () => {
    const pm = { findProcesses: () => { throw new ProcessListUnavailable('test'); } };
    expect(findOrphanProcesses(pm as any, '/path', [1, 2])).toEqual([]);
  });

  it('rethrows non-ProcessListUnavailable errors', () => {
    const pm = { findProcesses: () => { throw new Error('other'); } };
    expect(() => findOrphanProcesses(pm as any, '/path', [])).toThrow('other');
  });

  it('excludes given PIDs and process.pid', () => {
    const pm = { findProcesses: () => [1, 2, 3, process.pid] };
    expect(findOrphanProcesses(pm as any, '/path', [2])).toEqual([1, 3]);
  });
});
