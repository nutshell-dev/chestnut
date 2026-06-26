/**
 * Phase 143: gatherClawSnapshot 2 silent catch audit emit (A.8 续 2/~9)
 *
 * 反向测试：
 * 1. contract dir EACCES → emit CONTRACT_DIR_SCAN_FAILED
 * 2. contract dir ENOENT → 0 audit（合法 skip）
 * 3. inbox dir EIO → emit CLAW_DIR_LIST_FAILED + return 0
 * 4. inbox dir ENOENT → 0 audit + return 0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gatherClawSnapshot } from '../../src/watchdog/watchdog-utils.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';

const mockPm = { isAlive: vi.fn(() => true) };

function makeFs(opts: {
  contractDirError?: NodeJS.ErrnoException;
  inboxDirError?: NodeJS.ErrnoException;
  outboxDirError?: NodeJS.ErrnoException;
}) {
  return {
    listSync: vi.fn((dir: string, _options?: unknown) => {
      if (typeof dir === 'string' && dir.includes('contract')) {
        if (opts.contractDirError) throw opts.contractDirError;
        return [];
      }
      if (typeof dir === 'string' && dir.includes('inbox')) {
        if (opts.inboxDirError) throw opts.inboxDirError;
        return [];
      }
      if (typeof dir === 'string' && dir.includes('outbox')) {
        if (opts.outboxDirError) throw opts.outboxDirError;
        return [];
      }
      return [];
    }),
    readSync: vi.fn(() => ''),
    existsSync: vi.fn((dir: string) => {
      if (typeof dir === 'string' && (dir.includes('inbox') || dir.includes('outbox'))) return true;
      return false;
    }),
  };
}

describe('gatherClawSnapshot audit emit (phase 143)', () => {
  let mockAudit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockAudit = {
      write: vi.fn(),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
    };
    vi.clearAllMocks();
  });

  it('反向 1: contract dir EACCES → emit CONTRACT_DIR_SCAN_FAILED', () => {
    const fs = makeFs({
      contractDirError: Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    });
    const fsFactory = () => fs as unknown as import('../../src/foundation/fs/types.js').FileSystem;

    gatherClawSnapshot('/claw-X', fsFactory, mockPm, 'claw-X', mockAudit as unknown as import('../../src/foundation/audit/index.js').AuditLog);

    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED,
      expect.stringContaining('claw=claw-X'),
      expect.stringContaining('sub='),
      expect.stringContaining('error='),
    );
  });

  it('反向 2: contract dir ENOENT → 0 audit（合法 skip）', () => {
    const fs = makeFs({
      contractDirError: Object.assign(new Error('no such file'), { code: 'ENOENT' }),
    });
    const fsFactory = () => fs as unknown as import('../../src/foundation/fs/types.js').FileSystem;

    gatherClawSnapshot('/claw-X', fsFactory, mockPm, 'claw-X', mockAudit as unknown as import('../../src/foundation/audit/index.js').AuditLog);

    expect(mockAudit.write).not.toHaveBeenCalled();
  });

  it('反向 3: inbox dir EIO → silent (lightweight helper swallows) + return 0', () => {
    const fs = makeFs({
      inboxDirError: Object.assign(new Error('I/O error'), { code: 'EIO' }),
    });
    const fsFactory = () => fs as unknown as import('../../src/foundation/fs/types.js').FileSystem;

    const snap = gatherClawSnapshot('/claw-X', fsFactory, mockPm, 'claw-X', mockAudit as unknown as import('../../src/foundation/audit/index.js').AuditLog);

    expect(snap.inboxPending).toBe(0);
    // phase 746: peekPendingCount swallows read errors, no CLAW_DIR_LIST_FAILED audit
    expect(mockAudit.write).not.toHaveBeenCalled();
  });

  it('反向 4: inbox dir ENOENT → 0 audit + return 0', () => {
    const fs = makeFs({
      inboxDirError: Object.assign(new Error('no such file'), { code: 'ENOENT' }),
    });
    const fsFactory = () => fs as unknown as import('../../src/foundation/fs/types.js').FileSystem;

    const snap = gatherClawSnapshot('/claw-X', fsFactory, mockPm, 'claw-X', mockAudit as unknown as import('../../src/foundation/audit/index.js').AuditLog);

    expect(snap.inboxPending).toBe(0);
    expect(mockAudit.write).not.toHaveBeenCalled();
  });
});
