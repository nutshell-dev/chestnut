/**
 * Phase 1013 E.5: inbox-writer error narrow
 */

import { describe, it, expect } from 'vitest';
import { InboxWriter } from '../../../src/foundation/messaging/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFs(readSyncError?: { code: string; message: string }): FileSystem {
  return {
    readSync: () => {
      if (readSyncError) {
        const err = new Error(readSyncError.message) as any;
        err.code = readSyncError.code;
        throw err;
      }
      return '';
    },
  } as unknown as FileSystem;
}

describe('phase 1013 E.5: inbox-writer error narrow', () => {
  it('EACCES → permission_denied', () => {
    const fs = makeMockFs({ code: 'EACCES', message: 'Permission denied' });
    const result = InboxWriter.readMeta(fs, '/some/path');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('permission_denied');
    }
  });

  it('EPERM → permission_denied', () => {
    const fs = makeMockFs({ code: 'EPERM', message: 'Operation not permitted' });
    const result = InboxWriter.readMeta(fs, '/some/path');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('permission_denied');
    }
  });

  it('EIO → io_failed', () => {
    const fs = makeMockFs({ code: 'EIO', message: 'I/O error' });
    const result = InboxWriter.readMeta(fs, '/some/path');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('io_failed');
    }
  });

  it('EBUSY → io_failed', () => {
    const fs = makeMockFs({ code: 'EBUSY', message: 'Device busy' });
    const result = InboxWriter.readMeta(fs, '/some/path');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('io_failed');
    }
  });

  it('ENOSPC → io_failed', () => {
    const fs = makeMockFs({ code: 'ENOSPC', message: 'No space left' });
    const result = InboxWriter.readMeta(fs, '/some/path');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('io_failed');
    }
  });

  it('unknown error → read_failed (backward fallback)', () => {
    const fs = makeMockFs({ code: 'UNKNOWN', message: 'unknown' });
    const result = InboxWriter.readMeta(fs, '/some/path');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('read_failed');
    }
  });
});
