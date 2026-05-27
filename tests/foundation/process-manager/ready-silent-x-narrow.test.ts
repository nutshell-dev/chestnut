/**
 * Phase 1132 D.1: ready.ts isReady 3 bare catch → narrow ENOENT + audit emit
 *
 * 反向测试：
 * 1. non-ENOENT read error → READY_CHECK_READ_FAILED audit + return false
 * 2. ENOENT read → silent return false + 0 audit emit
 * 3. corrupt JSON → READY_CHECK_PARSE_FAILED audit + return false
 * 4. l1IsAlive throw → READY_CHECK_ISALIVE_THROW audit + return false
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { isReady } from '../../../src/foundation/process-manager/ready.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn().mockReturnValue(true),
  };
});

function makeMockFs(overrides?: {
  readSync?: (p: string) => string;
}): FileSystem {
  return {
    readSync: overrides?.readSync ?? vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    read: vi.fn(),
    writeAtomic: vi.fn(),
    writeAtomicSync: vi.fn(),
    append: vi.fn(),
    appendSync: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    ensureDir: vi.fn(),
    removeDir: vi.fn(),
    list: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    writeExclusiveSync: vi.fn(),
    readBytesSync: vi.fn(),
    statSync: vi.fn(),
  } as unknown as FileSystem;
}

describe('phase 1132 D.1: isReady narrow catch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('反向 1: non-ENOENT read error → READY_CHECK_READ_FAILED audit + return false', () => {
    const { audit, events } = makeAudit();
    const mockFs = makeMockFs({
      readSync: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }),
    });
    const ctx: ProcessManagerContext = {
      fs: mockFs,
      audit,
      resolveDir: (id: string) => path.join('/tmp', id),
    };

    expect(isReady(ctx, 'test-claw')).toBe(false);

    const readFailedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_READ_FAILED,
    );
    expect(readFailedEvents).toHaveLength(1);
    expect(readFailedEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_READ_FAILED,
        expect.stringContaining('claw=test-claw'),
        expect.stringContaining('reason='),
      ]),
    );
  });

  it('反向 2: ENOENT read → silent return false + 0 audit emit', () => {
    const { audit, events } = makeAudit();
    const mockFs = makeMockFs({
      readSync: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    });
    const ctx: ProcessManagerContext = {
      fs: mockFs,
      audit,
      resolveDir: (id: string) => path.join('/tmp', id),
    };

    expect(isReady(ctx, 'test-claw')).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('反向 3: corrupt JSON → READY_CHECK_PARSE_FAILED audit + return false', () => {
    const { audit, events } = makeAudit();
    let callCount = 0;
    const mockFs = makeMockFs({
      readSync: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return 'not-json';
        return JSON.stringify({ pid: 12345 });
      }),
    });
    const ctx: ProcessManagerContext = {
      fs: mockFs,
      audit,
      resolveDir: (id: string) => path.join('/tmp', id),
    };

    expect(isReady(ctx, 'test-claw')).toBe(false);

    const parseFailedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_PARSE_FAILED,
    );
    expect(parseFailedEvents).toHaveLength(1);
    expect(parseFailedEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_PARSE_FAILED,
        expect.stringContaining('claw=test-claw'),
        expect.stringContaining('reason='),
      ]),
    );
  });

  it('反向 4: l1IsAlive throw → READY_CHECK_ISALIVE_THROW audit + return false', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockImplementation(() => {
      throw new Error('ps exec failed');
    });

    const { audit, events } = makeAudit();
    const mockFs = makeMockFs({
      readSync: vi.fn().mockImplementation((p: string) => {
        if (p.includes('ready')) return JSON.stringify({ pid: 12345 });
        return JSON.stringify({ pid: 12345 });
      }),
    });
    const ctx: ProcessManagerContext = {
      fs: mockFs,
      audit,
      resolveDir: (id: string) => path.join('/tmp', id),
    };

    expect(isReady(ctx, 'test-claw')).toBe(false);

    const isAliveThrowEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW,
    );
    expect(isAliveThrowEvents).toHaveLength(1);
    expect(isAliveThrowEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW,
        expect.stringContaining('claw=test-claw'),
        expect.stringContaining('ready_pid=12345'),
        expect.stringContaining('reason='),
      ]),
    );
  });
});
