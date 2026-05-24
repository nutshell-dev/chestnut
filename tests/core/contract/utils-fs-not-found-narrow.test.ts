/**
 * Phase 1154 α-1 — utils.ts getContractCreatedMs FS_NOT_FOUND narrow 反向测试
 *
 * 反向 4 项:
 *   (1) paused/ 不存在 silent：mock fs.listSync throw FileNotFoundError → audit 0 emit
 *   (2) 非 ENOENT 真 emit：mock fs.listSync throw Error{code: 'EACCES'} → audit emit CONTRACT_DIR_SCAN_FAILED 1 次
 *   (3) raw ENOENT 兼容：mock fs.listSync throw Error{code: 'ENOENT'} → audit 0 emit
 *   (4) happy path 不动：mock fs.listSync 返合法 entries → audit 0 emit + 返 first timestamp
 */
import { describe, it, expect } from 'vitest';
import { getContractCreatedMs } from '../../../src/core/contract/utils.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeAudit } from '../../helpers/audit.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

describe('phase 1154 — utils.ts getContractCreatedMs FS_NOT_FOUND narrow', () => {
  it('silent for FileNotFoundError (FileSystem abstract layer)', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => { throw new FileNotFoundError('/tmp/claw/contract/active'); },
    } as unknown as FileSystem;
    const result = getContractCreatedMs(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('emits CONTRACT_DIR_SCAN_FAILED for EACCES', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    } as unknown as FileSystem;
    const result = getContractCreatedMs(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    expect(events).toHaveLength(2); // active + paused
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED);
    expect(events[0]).toContain('code=EACCES');
  });

  it('silent for raw ENOENT (Node native)', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    } as unknown as FileSystem;
    const result = getContractCreatedMs(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('happy path returns first timestamp and no audit', () => {
    const { audit, events } = makeAudit();
    const ts = Date.now();
    const fs = {
      listSync: () => [
        { name: `${ts}-contract1`, isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
        { name: `${ts + 1000}-contract2`, isDirectory: true, isFile: false, size: 0, mtime: new Date(), path: '' },
      ],
    } as unknown as FileSystem;
    const result = getContractCreatedMs(fs, '/tmp/claw', audit);
    expect(result).toBe(ts);
    expect(events).toHaveLength(0);
  });
});
