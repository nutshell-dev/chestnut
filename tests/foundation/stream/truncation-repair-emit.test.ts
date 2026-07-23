/**
 * Phase 1324 C.1 + Phase 1169 Step B: stream writer truncation repair audit emit
 */

import { describe, it, expect, vi } from 'vitest';
import { StreamWriter } from '../../../src/foundation/stream/writer.js';
import { STREAM_AUDIT_EVENTS } from '../../../src/foundation/stream/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFs(opts: {
  content?: string;
  readSyncThrow?: boolean;
  writeAtomicSyncThrow?: boolean;
} = {}): FileSystem {
  return {
    existsSync: vi.fn().mockReturnValue(true),
    readSync: vi.fn().mockImplementation(() => {
      if (opts.readSyncThrow) throw new Error('readSync explosion');
      return opts.content ?? 'incomplete line without newline';
    }),
    writeAtomicSync: vi.fn().mockImplementation(() => {
      if (opts.writeAtomicSyncThrow) {
        throw new Error('writeAtomicSync explosion');
      }
    }),
    ensureDirSync: vi.fn(),
    moveSync: vi.fn(),
    writeExclusiveSync: vi.fn(),
    appendSync: vi.fn(),
    listSync: vi.fn().mockReturnValue([]),
    deleteSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
  } as unknown as FileSystem;
}

function makeAudit(): {
  write: ReturnType<typeof vi.fn>;
  preview: ReturnType<typeof vi.fn>;
  events: Array<[string, ...string[]]>;
} {
  const events: Array<[string, ...string[]]> = [];
  const preview = vi.fn((value: string) => value);
  const write = vi.fn((type: string, ...cols: string[]) => {
    events.push([type, ...cols]);
  });
  return { write, preview, events };
}

describe('phase 1324 C.1 + phase 1169 Step B: stream truncation repair audit emit', () => {
  it('readSync throw during truncation repair → TRUNCATION_REPAIR_FAILED audit emitted + 0 REPAIRED + archive proceeds', () => {
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
    const repairedEvents = audit.events.filter(
      e => e[0] === STREAM_AUDIT_EVENTS.TRUNCATION_REPAIRED,
    );
    expect(repairedEvents.length).toBe(0);
    // Archive still proceeds despite repair failure
    expect(fs.moveSync).toHaveBeenCalled();
  });

  it('readSync success + complete last line → 0 TRUNCATION_REPAIR_FAILED + 0 TRUNCATION_REPAIRED + no atomic write', () => {
    const fs = makeMockFs({ content: '{"ts":1,"type":"ok"}\n' });
    const audit = makeAudit();
    const writer = new StreamWriter(fs, audit as any);

    writer.open();

    const repairFailedEvents = audit.events.filter(
      e => e[0] === STREAM_AUDIT_EVENTS.TRUNCATION_REPAIR_FAILED,
    );
    expect(repairFailedEvents.length).toBe(0);
    const repairedEvents = audit.events.filter(
      e => e[0] === STREAM_AUDIT_EVENTS.TRUNCATION_REPAIRED,
    );
    expect(repairedEvents.length).toBe(0);
    expect(fs.writeAtomicSync).not.toHaveBeenCalled();
  });

  it('readSync success + incomplete Unicode tail → TRUNCATION_REPAIRED with UTF-8 byte counts + preview + archive proceeds', () => {
    const retained = '{"ts":1,"type":"ok","text":"中文"}\n';
    const dropped = '{"ts":2,"type":"partial","text":"🙂';
    const fs = makeMockFs({ content: retained + dropped });
    const audit = makeAudit();
    const writer = new StreamWriter(fs, audit as any);

    writer.open();

    expect(fs.writeAtomicSync).toHaveBeenCalledWith('stream.jsonl', retained);
    expect(audit.preview).toHaveBeenCalledTimes(1);
    expect(audit.preview).toHaveBeenCalledWith(dropped);

    const repairedEvents = audit.events.filter(
      e => e[0] === STREAM_AUDIT_EVENTS.TRUNCATION_REPAIRED,
    );
    expect(repairedEvents.length).toBe(1);
    expect(repairedEvents[0]).toEqual([
      STREAM_AUDIT_EVENTS.TRUNCATION_REPAIRED,
      'path=stream.jsonl',
      `retained_bytes=${Buffer.byteLength(retained, 'utf-8')}`,
      `dropped_bytes=${Buffer.byteLength(dropped, 'utf-8')}`,
      `dropped_preview=${dropped}`,
    ]);

    const repairFailedEvents = audit.events.filter(
      e => e[0] === STREAM_AUDIT_EVENTS.TRUNCATION_REPAIR_FAILED,
    );
    expect(repairFailedEvents.length).toBe(0);
    expect(fs.moveSync).toHaveBeenCalled();
  });

  it('writeAtomicSync throw during truncation repair → 0 TRUNCATION_REPAIRED + TRUNCATION_REPAIR_FAILED + archive proceeds', () => {
    const fs = makeMockFs({
      content: '{"ts":1,"type":"ok"}\n{"ts":2,"type":"partial"',
      writeAtomicSyncThrow: true,
    });
    const audit = makeAudit();
    const writer = new StreamWriter(fs, audit as any);

    writer.open();

    const repairedEvents = audit.events.filter(
      e => e[0] === STREAM_AUDIT_EVENTS.TRUNCATION_REPAIRED,
    );
    expect(repairedEvents.length).toBe(0);

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
    expect(fs.moveSync).toHaveBeenCalled();
  });
});
