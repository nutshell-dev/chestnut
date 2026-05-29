/**
 * Phase 1010 r123 B fork — silent X catch ALL TODO cluster 4 site narrow + audit emit
 * audit-2026-05-18 §Section 1
 *
 * 反向 3 项:
 *   (1) ENOENT path 仍 silent (first-run state 兼容)
 *   (2) 非 ENOENT (EACCES) → audit emit + 行为兼容 (不 throw / 默认值)
 *   (3) audit const name 锁 (NEW 3 const 全 verify 拼写 + 命名 invariant)
 */
import { describe, it, expect, vi } from 'vitest';
import { collectContractEvents } from '../../../src/core/contract/jobs/event-collector.js';
import { getContractCreatedMs } from '../../../src/core/contract/utils.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeAudit } from '../../helpers/audit.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeFsThrow(code: string): FileSystem {
  return {
    listSync: () => {
      const err = new Error(`EACCES: permission denied`) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    },
    readSync: () => {
      const err = new Error(`EACCES: permission denied`) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    },
    existsSync: () => true,
    ensureDirSync: () => {},
    writeAtomicSync: () => {},
  } as unknown as FileSystem;
}

describe('phase 1010 — silent X TODO cluster narrow', () => {
  it('event-collector.ts archive ENOENT silent (first-run)', () => {
    const { audit, events } = makeAudit();
    const fs = makeFsThrow('ENOENT');
    const result = collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('event-collector.ts archive EACCES → EVENT_COLLECTOR_SCAN_FAILED audit', () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: (p: string) => {
        if (p.includes('archive')) {
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return [];
      },
      readSync: () => '',
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED);
    expect(events[0]).toContain('dir=archive');
    expect(events[0]).toContain('code=EACCES');
  });

  it('utils.ts getContractCreatedMs ENOENT silent', () => {
    const { audit, events } = makeAudit();
    const fs = makeFsThrow('ENOENT');
    const result = getContractCreatedMs(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('utils.ts getContractCreatedMs EACCES → CONTRACT_DIR_SCAN_FAILED audit (when audit param 注入)', () => {
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
    // getContractCreatedMs 循环 ['active', 'paused'] 两个子目录，各触发 1 次 audit
    expect(events).toHaveLength(2);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED);
    expect(events[0]).toContain('code=EACCES');
  });

  it('utils.ts getContractCreatedMs EACCES 无 audit param → silent (兼容旧 caller)', () => {
    const fs = makeFsThrow('EACCES');
    const result = getContractCreatedMs(fs, '/tmp/claw');
    expect(result).toBeNull();
    // 无 audit param、不抛、不 audit、行为兼容
  });

  it('contract-observer.ts state load ENOENT silent + lastCheckTs=0', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      readSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      existsSync: () => true,
      ensureDirSync: () => {},
      writeAtomicSync: () => {},
    } as unknown as FileSystem;
    const notifyInbox = vi.fn();
    await runContractObserver({
      clawforumRoot: '/tmp/test',
      fs,
      motionAudit: audit,
      notifyClaw: notifyInbox,
    });
    expect(events).toHaveLength(0);
    // 无事件、不 notify
    expect(notifyInbox).not.toHaveBeenCalled();
  });

  it('contract-observer.ts state load EACCES → OBSERVER_STATE_LOAD_FAILED audit + lastCheckTs=0 行为兼容', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => [],
      readSync: () => {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
      existsSync: () => true,
      ensureDirSync: () => {},
      writeAtomicSync: () => {},
    } as unknown as FileSystem;
    const notifyInbox = vi.fn();
    await runContractObserver({
      clawforumRoot: '/tmp/test',
      fs,
      motionAudit: audit,
      notifyClaw: notifyInbox,
    });
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED);
    expect(events[0]).toContain('code=EACCES');
    expect(notifyInbox).not.toHaveBeenCalled();
  });

  it('NEW 3 audit const name invariant', () => {
    expect(CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED).toBe('contract_event_collector_scan_failed');
    expect(CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED).toBe('contract_dir_scan_failed');
    expect(CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED).toBe('contract_observer_state_load_failed');
  });
});
