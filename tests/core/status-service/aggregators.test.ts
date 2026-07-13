/**
 * Aggregator pure-function tests — phase 1472 Step A.
 *
 * Covers computeContractView / computeTaskView / computeStorageView +
 * format helpers. Verify error views + format outputs equivalent to legacy
 * status-tool string output.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeContractView,
  computeTaskView,
  computeStorageView,
  formatContractView,
  formatTaskView,
  formatStorageView,
} from '../../../src/core/status-service/aggregators.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { ContractSystem } from '../../../src/core/contract/index.js';

// ── Contract ────────────────────────────────────────────────────────────────

describe('computeContractView', () => {
  it('returns no-active when contractSystem.loadActive() returns null', async () => {
    const cs = { loadActive: vi.fn().mockResolvedValue(null) } as unknown as ContractSystem;
    const v = await computeContractView(cs);
    expect(v.type).toBe('no-active');
    expect(formatContractView(v)).toBe('Contract: No active contract');
  });

  it('returns active view with subtask icons + counts', async () => {
    const cs = {
      loadActive: vi.fn().mockResolvedValue({
        title: 'refactor',
        subtasks: [
          { id: 's1', description: 'do a', status: 'completed' },
          { id: 's2', description: 'do b', status: 'pending' },
        ],
      }),
    } as unknown as ContractSystem;
    const v = await computeContractView(cs);
    expect(v.type).toBe('active');
    if (v.type === 'active') {
      expect(v.doneCount).toBe(1);
      expect(v.totalCount).toBe(2);
    }
    const lines = formatContractView(v).split('\n');
    expect(lines[0]).toBe('Contract: "refactor" (1/2 subtasks done)');
    expect(lines[1]).toBe('  ✓ s1: do a');
    expect(lines[2]).toBe('  ○ s2: do b');
  });

  it('returns error view + format "Contract: Error loading" when loadActive throws', async () => {
    const cs = {
      loadActive: vi.fn().mockRejectedValue(new Error('disk read fail')),
    } as unknown as ContractSystem;
    const v = await computeContractView(cs);
    expect(v.type).toBe('error');
    if (v.type === 'error') {
      expect(v.message).toBe('disk read fail');
    }
    expect(formatContractView(v)).toBe('Contract: Error loading');
  });
});

// ── Task ────────────────────────────────────────────────────────────────────

describe('computeTaskView', () => {
  it('idle when pending + running both empty', async () => {
    const fs = { list: vi.fn().mockResolvedValue([]) } as unknown as FileSystem;
    const v = await computeTaskView(fs);
    expect(formatTaskView(v)).toBe('Tasks: idle');
  });

  it('idle when both queues throw FS_NOT_FOUND (no errors recorded)', async () => {
    const fs = {
      list: vi.fn().mockRejectedValue(new FileNotFoundError('/tasks/queues/x')),
    } as unknown as FileSystem;
    const v = await computeTaskView(fs);
    expect(v.type).toBe('counts');
    if (v.type === 'counts') {
      expect(v.pending).toBe(0);
      expect(v.running).toBe(0);
      expect(v.pendingError).toBeUndefined();
      expect(v.runningError).toBeUndefined();
    }
    expect(formatTaskView(v)).toBe('Tasks: idle');
  });

  it('records pendingError when pending throws non-FS_NOT_FOUND', async () => {
    let n = 0;
    const fs = {
      list: vi.fn().mockImplementation(async () => {
        n++;
        if (n === 1) throw new Error('perm denied');
        return [];
      }),
    } as unknown as FileSystem;
    const v = await computeTaskView(fs);
    expect(v.type).toBe('counts');
    if (v.type === 'counts') {
      expect(v.pendingError).toBe('perm denied');
      expect(v.runningError).toBeUndefined();
    }
  });

  it('formats "N running, M pending" when running > 0', async () => {
    let n = 0;
    const fs = {
      list: vi.fn().mockImplementation(async () => {
        n++;
        if (n === 1) return [{ name: 'a' }, { name: 'b' }, { name: 'c' }]; // pending=3
        return [{ name: 'x' }, { name: 'y' }]; // running=2
      }),
    } as unknown as FileSystem;
    const v = await computeTaskView(fs);
    expect(formatTaskView(v)).toBe('Tasks: 2 running, 3 pending');
  });

  it('formats "N pending" when running=0 + pending>0', async () => {
    let n = 0;
    const fs = {
      list: vi.fn().mockImplementation(async () => {
        n++;
        if (n === 1) return [{ name: 'a' }]; // pending=1
        return []; // running=0
      }),
    } as unknown as FileSystem;
    const v = await computeTaskView(fs);
    expect(formatTaskView(v)).toBe('Tasks: 1 pending');
  });

  it('shows pendingError in formatted output', () => {
    const v: import('../../../src/core/status-service/aggregators.js').TaskView = {
      type: 'counts',
      running: 0,
      pending: 0,
      pendingError: 'EACCES',
    };
    expect(formatTaskView(v)).toContain('pending error: EACCES');
  });

  it('shows runningError alongside counts', () => {
    const v: import('../../../src/core/status-service/aggregators.js').TaskView = {
      type: 'counts',
      running: 2,
      pending: 1,
      runningError: 'EIO',
    };
    const out = formatTaskView(v);
    expect(out).toContain('2 running');
    expect(out).toContain('running error: EIO');
  });
});

// ── Storage ─────────────────────────────────────────────────────────────────

describe('computeStorageView', () => {
  it('MEMORY.md size + clawspace count', async () => {
    const fs = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue('x'.repeat(2048)),
      list: vi.fn().mockResolvedValue([{ name: 'a' }, { name: 'b' }, { name: 'c' }]),
    } as unknown as FileSystem;
    const v = await computeStorageView(fs);
    expect(v.memoryMd).toEqual({ type: 'size', bytes: 2048 });
    expect(v.clawspace).toEqual({ type: 'count', files: 3 });
    expect(formatStorageView(v)).toEqual(['MEMORY.md: 2.0KB', 'Clawspace: 3 files']);
  });

  it('MEMORY.md not found + clawspace 0 when both ENOENT', async () => {
    const fs = {
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockRejectedValue(new FileNotFoundError('/clawspace')),
    } as unknown as FileSystem;
    const v = await computeStorageView(fs);
    expect(v.memoryMd).toEqual({ type: 'not-found' });
    expect(v.clawspace).toEqual({ type: 'count', files: 0 });
    expect(formatStorageView(v)).toEqual(['MEMORY.md: Not found', 'Clawspace: 0 files']);
  });

  it('MEMORY.md error + clawspace error when both throw non-ENOENT', async () => {
    const fs = {
      exists: vi.fn().mockRejectedValue(new Error('mem err')),
      list: vi.fn().mockRejectedValue(new Error('clawspace err')),
    } as unknown as FileSystem;
    const v = await computeStorageView(fs);
    expect(v.memoryMd.type).toBe('error');
    expect(v.clawspace.type).toBe('error');
    const lines = formatStorageView(v);
    expect(lines[0]).toContain('MEMORY.md: Error');
    expect(lines[1]).toContain('Clawspace: Error');
  });

  it('MEMORY.md size uses byte length for multibyte UTF-8', async () => {
    const content = '中'.repeat(1000);
    const fs = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(content),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as FileSystem;
    const v = await computeStorageView(fs);
    expect(v.memoryMd).toEqual({ type: 'size', bytes: 3000 });
    expect(formatStorageView(v)).toContain('MEMORY.md: 2.9KB');
  });
});

// ── Reverse ─────────────────────────────────────────────────────────────────

describe('reverse', () => {
  it('formatContractView preserves subtask order', async () => {
    const cs = {
      loadActive: vi.fn().mockResolvedValue({
        title: 't',
        subtasks: [
          { id: 'z', description: 'last', status: 'pending' },
          { id: 'a', description: 'first', status: 'pending' },
        ],
      }),
    } as unknown as ContractSystem;
    const v = await computeContractView(cs);
    const out = formatContractView(v);
    const zIdx = out.indexOf('z:');
    const aIdx = out.indexOf('a:');
    expect(zIdx).toBeLessThan(aIdx);
  });

  it('aggregator never throws — error always folded into view', async () => {
    const fs = {
      list: vi.fn().mockImplementation(() => {
        throw new TypeError('synchronous throw');
      }),
      exists: vi.fn().mockImplementation(() => {
        throw new TypeError('synchronous throw');
      }),
    } as unknown as FileSystem;
    await expect(computeTaskView(fs)).resolves.toBeDefined();
    await expect(computeStorageView(fs)).resolves.toBeDefined();
  });

  it('formatTaskView shows unavailable on outer catch path', () => {
    expect(formatTaskView({ type: 'unavailable', message: 'X' })).toBe('Tasks: unavailable (X)');
  });
});
