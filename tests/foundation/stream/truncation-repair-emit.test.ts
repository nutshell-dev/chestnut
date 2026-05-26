/**
 * Phase 1324 C.1: stream writer truncation repair fail → audit emit
 */

import { describe, it, expect, vi } from 'vitest';
import { StreamWriter } from '../../../src/foundation/stream/writer.js';
import { STREAM_AUDIT_EVENTS } from '../../../src/foundation/stream/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFs(opts: { readSyncThrow?: boolean } = {}): FileSystem {
  return {
    existsSync: vi.fn().mockReturnValue(true),
    readSync: vi.fn().mockImplementation(() => {
      if (opts.readSyncThrow) throw new Error('readSync explosion');
      return 'incomplete line without newline';
    }),
    writeAtomicSync: vi.fn(),
    ensureDirSync: vi.fn(),
    moveSync: vi.fn(),
    writeExclusiveSync: vi.fn(),
    appendSync: vi.fn(),
    listSync: vi.fn().mockReturnValue([]),
    deleteSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
  } as unknown as FileSystem;
}

function makeAudit(): { write: typeof vi.fn; events: Array<[string, ...string[]]> } {
  const events: Array<[string, ...string[]]> = [];
  const write = vi.fn((type: string, ...cols: string[]) => {
    events.push([type, ...cols]);
  });
  return { write, events };
}

describe('phase 1324 C.1: stream truncation repair fail audit emit', () => {
  it('readSync throw during truncation repair → TRUNCATION_REPAIR_FAILED audit emitted + archive proceeds', () => {
    const fs = makeMockFs({ readSyncThrow: true });
    const audit = makeAudit();
    const writer = new StreamWriter(fs, audit as any);

    writer.open();

    const repairFailedEvents = audit.events.filter(
      e => e[0] === STREAM_AUDIT_EVENTS.TRUNCATION_REPAIR_FAILED,
    );
    expect(repairFailedEvents.length).toBe(1);
    expect(repairFailedEvents[0]).toEqual(
      expect.arrayContaining([
        STREAM_AUDIT_EVENTS.TRUNCATION_REPAIR_FAILED,
        expect.stringContaining('reason='),
        'archive_will_proceed=true',
      ]),
    );
    // Archive still proceeds despite repair failure
    expect(fs.moveSync).toHaveBeenCalled();
  });

  it('readSync success + complete last line → 0 TRUNCATION_REPAIR_FAILED', () => {
    const fs = makeMockFs();
    const audit = makeAudit();
    const writer = new StreamWriter(fs, audit as any);

    writer.open();

    const repairFailedEvents = audit.events.filter(
      e => e[0] === STREAM_AUDIT_EVENTS.TRUNCATION_REPAIR_FAILED,
    );
    expect(repairFailedEvents.length).toBe(0);
  });
});
