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
import { getActiveContractTimestamp } from '../../../src/core/contract/lightweight-query.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeAudit } from '../../helpers/audit.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import * as path from 'path';

function makeMockTopology(fs: FileSystem, clawsDir: string): ClawTopology {
  return {
    enumerate() {
      const entries = fs.listSync(clawsDir, { includeDirs: true });
      return entries.filter(e => e.isDirectory).map(e => e.name);
    },
    resolve(clawId) {
      return { kind: 'local', clawDir: path.join(clawsDir, clawId) };
    },
    async read() { return ''; },
    async readJSON() { return {} as any; },
  };
}

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
  it('event-collector.ts archive ENOENT silent (first-run)', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsThrow('ENOENT');
    const result = await collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result.events).toEqual([]);
    expect(result.problemPairs).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('event-collector.ts archive EACCES → EVENT_COLLECTOR_SCAN_FAILED audit', async () => {
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
    const result = await collectContractEvents(fs, '/tmp/claw', 'claw1', 0, audit);
    expect(result.events).toEqual([]);
    expect(result.problemPairs).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED);
    // phase 717: src 改 dir col 为实际 archiveDir 路径、test 改子串 match
    expect(events[0].join('|')).toMatch(/dir=.*archive/);
    expect(events[0]).toContain('code=EACCES');
  });

  it('lightweight-query.ts getActiveContractTimestamp ENOENT silent', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      ...makeFsThrow('ENOENT'),
      existsSync: () => true,
    };
    const result = getActiveContractTimestamp(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('lightweight-query.ts getActiveContractTimestamp EACCES → CONTRACT_DIR_SCAN_FAILED audit (when audit param 注入)', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      listSync: () => {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
      existsSync: () => true,
    } as unknown as FileSystem;
    const result = getActiveContractTimestamp(fs, '/tmp/claw', audit);
    expect(result).toBeNull();
    // getActiveContractTimestamp 仅扫描 active 目录，触发 1 次 audit
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED);
    expect(events[0]).toContain('code=EACCES');
  });

  it('lightweight-query.ts getActiveContractTimestamp EACCES 无 audit param → silent (兼容旧 caller)', async () => {
    const fs = {
      ...makeFsThrow('EACCES'),
      existsSync: () => true,
    };
    const result = getActiveContractTimestamp(fs, '/tmp/claw');
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
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: audit,
      notifyMotion: notifyInbox,
    });
    expect(events).toHaveLength(0);
    // 无事件、不 notify
    expect(notifyInbox).not.toHaveBeenCalled();
  });

  it('contract-observer.ts state load EACCES → OBSERVER_STATE_LOAD_FAILED audit + throw (phase 946 fail-closed)', async () => {
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
    const notifyInbox = vi.fn().mockResolvedValue(undefined);
    await expect(runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: audit,
      notifyMotion: notifyInbox,
    })).rejects.toThrow('Observer state corrupt');
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED);
    expect(events[0]).toContain('reason=read_failed:EACCES:EACCES');
    expect(notifyInbox).not.toHaveBeenCalled();
  });

  it('NEW 3 audit const name invariant', async () => {
    expect(CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED).toBe('contract_event_collector_scan_failed');
    expect(CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED).toBe('contract_dir_scan_failed');
    expect(CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED).toBe('contract_observer_state_load_failed');
  });
});
