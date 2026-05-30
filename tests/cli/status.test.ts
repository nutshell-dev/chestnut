/**
 * Phase 1478: orphan-helper logic moved into core/status-service/forum-aggregators
 * (as `findOrphans`). These tests cover the same surface via the new location;
 * the prior `findOrphanProcesses` symbol in src/cli/commands/status.ts is gone.
 */

import { describe, it, expect } from 'vitest';
import { findOrphans } from '../../src/core/status-service/index.js';
import { ProcessListUnavailable } from '../../src/foundation/process-manager/index.js';

describe('findOrphans (status-service)', () => {
  it('returns empty array on ProcessListUnavailable (graceful skip)', () => {
    const pm = { findProcesses: () => { throw new ProcessListUnavailable('test'); } };
    expect(findOrphans(pm as any, '/path', [1, 2])).toEqual([]);
  });

  it('rethrows non-ProcessListUnavailable errors', () => {
    const pm = { findProcesses: () => { throw new Error('other'); } };
    expect(() => findOrphans(pm as any, '/path', [])).toThrow('other');
  });

  it('excludes given PIDs and process.pid', () => {
    const pm = { findProcesses: () => [1, 2, 3, process.pid] };
    expect(findOrphans(pm as any, '/path', [2])).toEqual([1, 3]);
  });
});
