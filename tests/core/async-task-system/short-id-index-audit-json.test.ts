/**
 * Phase 858: shortIdIndexAuditWriter serializes complex values with JSON.stringify.
 */
import { describe, it, expect, vi } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import type { ShortIdIndex, AsyncTaskSystemOptions } from '../../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeMockFs(): FileSystem {
  return {
    existsSync: vi.fn(() => false),
    listSync: vi.fn(() => []),
  } as unknown as FileSystem;
}

function makeMockAudit(): AuditLog {
  return {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  } as unknown as AuditLog;
}

function makeMockShortIdIndex(): ShortIdIndex {
  return {
    needsRebuild: false,
    load: vi.fn(),
    save: vi.fn(),
    resolve: vi.fn(),
    add: vi.fn(),
    rebuildFromDisk: vi.fn(),
  } as unknown as ShortIdIndex;
}

function makeSystem(audit: AuditLog): AsyncTaskSystem {
  const fs = makeMockFs();
  const options: AsyncTaskSystemOptions = {
    auditWriter: audit,
    llm: {} as any,
    contractManager: {} as any,
    outboxWriter: {} as any,
    registry: { getAll: vi.fn(() => []) } as any,
    fsFactory: () => fs,
    askMotionToolFactory: () => ({} as any),
    shortIdIndex: makeMockShortIdIndex(),
  };
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  return new AsyncTaskSystem('/tmp', fs, options);
}

describe('shortIdIndexAuditWriter JSON serialization (phase 858)', () => {
  it('serializes string/number/boolean with String() (no extra quotes)', () => {
    const audit = makeMockAudit();
    const system = makeSystem(audit);
    const writer = (system as any).shortIdIndexAuditWriter;

    writer.write('test_event', {
      str: 'hello',
      num: 42,
      bool: true,
    });

    expect(audit.write).toHaveBeenCalledWith(
      'test_event',
      'str=hello',
      'num=42',
      'bool=true',
    );
  });

  it('serializes object/array with JSON.stringify', () => {
    const audit = makeMockAudit();
    const system = makeSystem(audit);
    const writer = (system as any).shortIdIndexAuditWriter;

    writer.write('short_id_collision', {
      collisions: [
        { shortId: 'abc', existingFullId: 'id-1', conflictingFullId: 'id-2' },
      ],
      entryCount: 3,
    });

    const callArgs = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
    expect(callArgs[0]).toBe('short_id_collision');
    const collisionsCol = callArgs.find(a => typeof a === 'string' && a.startsWith('collisions='));
    expect(collisionsCol).toBeDefined();
    const json = collisionsCol!.slice('collisions='.length);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([
      { shortId: 'abc', existingFullId: 'id-1', conflictingFullId: 'id-2' },
    ]);
    expect(callArgs).toContain('entryCount=3');
  });
});
