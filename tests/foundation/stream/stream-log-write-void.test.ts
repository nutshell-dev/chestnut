/**
 * Phase 1152 G.1: StreamLog.write boolean → void collapse reverse tests
 */
import { describe, it, expect, vi } from 'vitest';
import { PerResourceStreamWriter } from '../../../src/foundation/stream/per-resource-writer.js';
import { StreamWriter } from '../../../src/foundation/stream/writer.js';
import { STREAM_AUDIT_EVENTS } from '../../../src/foundation/stream/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFs(): FileSystem {
  return {
    appendSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
    moveSync: vi.fn(),
    existsSync: vi.fn(() => false),
    listSync: vi.fn(() => []),
    readSync: vi.fn(() => ''),
    writeAtomicSync: vi.fn(),
    ensureDirSync: vi.fn(),
    deleteSync: vi.fn(),
    writeExclusiveSync: vi.fn(),
  } as unknown as FileSystem;
}

function makeAudit(): { write: typeof vi.fn; events: Array<[string, ...string[]]> } {
  const events: Array<[string, ...string[]]> = [];
  const write = vi.fn((type: string, ...cols: string[]) => {
    events.push([type, ...cols]);
  });
  return { write, events };
}

describe('StreamLog.write void signature (phase 1152 G.1)', () => {
  it('happy path: PerResourceStreamWriter.write does not throw + audit 0 emit', () => {
    const fs = makeMockFs();
    const audit = makeAudit();
    const writer = new PerResourceStreamWriter(fs, '/tmp/test/stream.jsonl', audit as any);

    expect(() => writer.write({ ts: 1, type: 'test_event' })).not.toThrow();
    expect(audit.events.length).toBe(0);
    expect(fs.appendSync).toHaveBeenCalledWith('/tmp/test/stream.jsonl', expect.any(String));
  });

  it('failure path: appendSync throws → audit emits APPEND_FAILED with path forensics', () => {
    const fs = makeMockFs();
    (fs.appendSync as any).mockImplementation(() => {
      throw new Error('disk full');
    });
    const audit = makeAudit();
    const writer = new PerResourceStreamWriter(fs, '/tmp/agents/agent-42/stream.jsonl', audit as any);

    expect(() => writer.write({ ts: 1, type: 'turn_start' })).not.toThrow();
    expect(audit.events.length).toBe(1);
    expect(audit.events[0][0]).toBe(STREAM_AUDIT_EVENTS.APPEND_FAILED);
    // path must contain agentId for forensics completeness
    expect(audit.events[0].some(col => col.startsWith('path=') && col.includes('agent-42'))).toBe(true);
    expect(audit.events[0].some(col => col.startsWith('type='))).toBe(true);
    expect(audit.events[0].some(col => col.startsWith('body='))).toBe(true);
  });

  it('sig invariant: StreamWriter.write returns void at compile-time', () => {
    // Runtime check: write() does not return a truthy value
    const fs = makeMockFs();
    const audit = makeAudit();
    const writer = new StreamWriter(fs, audit as any);
    // open() is required before write()
    (fs.existsSync as any).mockReturnValue(false);
    (fs as any).options = { baseDir: '/tmp' };
    writer.open();

    const result = writer.write({ ts: 1, type: 'test' });
    expect(result).toBeUndefined();
  });
});
