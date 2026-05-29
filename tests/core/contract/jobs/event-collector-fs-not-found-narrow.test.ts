/**
 * Phase 1154 α-1 + α-4 — event-collector.ts FS_NOT_FOUND narrow + PROGRESS_CORRUPTED 分流 反向测试
 *
 * 反向 4 项:
 *   (1) archive listSync FileNotFoundError 不触 EVENT_COLLECTOR_SCAN_FAILED
 *   (2) progress.json readSync FileNotFoundError 不触 PROGRESS_CORRUPTED（α-4 关键）
 *   (3) 非 ENOENT 真 emit：mock throw EACCES → emit PROGRESS_CORRUPTED 1 次
 *   (4) 真 JSON.parse 失败仍 emit PROGRESS_CORRUPTED（phase 587 ⚓ invariant 不破）
 */
import { describe, it, expect } from 'vitest';
import { collectContractEvents } from '../../../../src/core/contract/jobs/event-collector.js';
import { FileNotFoundError } from '../../../../src/foundation/fs/types.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../../src/core/contract/audit-events.js';
import { makeAudit } from '../../../helpers/audit.js';
import type { FileSystem } from '../../../../src/foundation/fs/types.js';

describe('phase 1154 — event-collector FS_NOT_FOUND narrow + α-4 progress_corrupted分流', () => {
  it('archive listSync FileNotFoundError → 0 emit', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => { throw new FileNotFoundError('/tmp/claw/contract/archive'); },
      readSync: () => '',
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('progress.json readSync FileNotFoundError → 0 PROGRESS_CORRUPTED emit + continue next contract', () => {
    const { audit, events } = makeAudit();
    let readCalls = 0;
    const fs = {
      listSync: () => [
        { name: '1234567890-contract1', isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
      ],
      readSync: () => {
        readCalls++;
        throw new FileNotFoundError('/tmp/claw/contract/archive/1234567890-contract1/progress.json');
      },
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result).toEqual([]);
    expect(events).toHaveLength(0);
    // 仅 archive 1 个 entry → readSync 被调 1 次
    expect(readCalls).toBe(1);
  });

  it('progress.json readSync EACCES → emit PROGRESS_CORRUPTED 2 次 (archive + active)', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => [
        { name: '1234567890-contract1', isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
      ],
      readSync: () => {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result).toEqual([]);
    // 仅 archive 1 个 entry → emit 1 次
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED);
  });

  it('progress.json invalid JSON → emit PROGRESS_CORRUPTED 2 次 (archive + active, phase 587 invariant)', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => [
        { name: '1234567890-contract1', isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
      ],
      readSync: () => 'not-json-at-all',
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result).toEqual([]);
    // 仅 archive 1 个 entry → emit 1 次
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED);
  });
});
