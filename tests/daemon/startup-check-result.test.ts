/**
 * Phase 858: startup-check fail-closed behavior with lightweight-query Result.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isInboxEmpty,
  hasPendingStartupCheck,
  shouldEmitStartupCheck,
} from '../../src/daemon/startup-check.js';
import { DAEMON_AUDIT_EVENTS } from '../../src/daemon/audit-events.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';

function makeFs(opts: { inboxListError?: NodeJS.ErrnoException; inboxExists?: boolean }): FileSystem {
  return {
    existsSync: vi.fn((dir: string) => {
      if (typeof dir === 'string' && dir.includes('inbox/pending')) {
        return opts.inboxExists ?? true;
      }
      return false;
    }),
    listSync: vi.fn((_dir: string, _options?: unknown) => {
      if (opts.inboxListError) throw opts.inboxListError;
      return [];
    }),
  } as unknown as FileSystem;
}

function makeAudit() {
  return {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  };
}

describe('startup-check Result adaptation (phase 858)', () => {
  it('isInboxEmpty returns false and emits audit on I/O error (fail-closed)', () => {
    const fs = makeFs({
      inboxListError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const audit = makeAudit();

    expect(isInboxEmpty(fs, audit as any)).toBe(false);
    expect(audit.write).toHaveBeenCalledWith(
      DAEMON_AUDIT_EVENTS.STARTUP_CHECK_IO_ERROR,
      expect.stringContaining('fn=peekPendingCount'),
      expect.stringContaining('reason='),
    );
  });

  it('isInboxEmpty returns true when inbox has no pending .md files', () => {
    const fs = makeFs({});
    const audit = makeAudit();

    expect(isInboxEmpty(fs, audit as any)).toBe(true);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('hasPendingStartupCheck returns true and emits audit on I/O error (fail-closed)', () => {
    const fs = makeFs({
      inboxListError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const audit = makeAudit();

    expect(hasPendingStartupCheck(fs, audit as any)).toBe(true);
    expect(audit.write).toHaveBeenCalledWith(
      DAEMON_AUDIT_EVENTS.STARTUP_CHECK_IO_ERROR,
      expect.stringContaining('fn=peekPendingFilenames'),
      expect.stringContaining('reason='),
    );
  });

  it('hasPendingStartupCheck returns true when a startup_check file is pending', () => {
    const fs = {
      existsSync: vi.fn(() => true),
      listSync: vi.fn(() => [
        { name: '2026-01-01_startup_check_x.md', isDirectory: () => false, isFile: () => true },
      ]),
    } as unknown as FileSystem;
    const audit = makeAudit();

    expect(hasPendingStartupCheck(fs, audit as any)).toBe(true);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('shouldEmitStartupCheck returns false when peekPendingCount errors (fail-closed)', () => {
    const fs = makeFs({
      inboxListError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const audit = makeAudit();

    // Even if other conditions would be true, I/O error on inbox makes isInboxEmpty false.
    expect(shouldEmitStartupCheck(fs, audit as any)).toBe(false);
  });
});
