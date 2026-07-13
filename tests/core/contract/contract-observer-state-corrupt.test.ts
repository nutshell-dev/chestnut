import { describe, it, expect, vi } from 'vitest';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import * as path from 'path';

function makeFsMockWithState(stateContent: string): FileSystem {
  const files = new Map<string, string>();
  files.set('/tmp/test/motion/status/contract-observer-state.json', stateContent);

  const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();
  dirs.set('/tmp/test/claws', []);

  return {
    existsSync: (p: string) => dirs.has(p) || files.has(p),
    listSync: (p: string) => dirs.get(p) ?? [],
    readSync: (p: string) => {
      if (files.has(p)) return files.get(p)!;
      throw new Error('ENOENT');
    },
    ensureDirSync: () => {},
    writeAtomicSync: () => {},
  } as unknown as FileSystem;
}

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

function makeAuditMock(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

describe('contract observer state file corrupt (phase 946)', () => {
  it('lastCheckTs string → throws and audits OBSERVER_STATE_LOAD_FAILED', async () => {
    const fs = makeFsMockWithState(JSON.stringify({ lastCheckTs: 'abc' }));
    const { audit, events } = makeAuditMock();

    await expect(runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: audit,
      notifyMotion: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Observer state corrupt');

    const loadFailedEvents = events.filter(
      (e) => e[0] === CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
    );
    expect(loadFailedEvents.length).toBe(1);
    expect(loadFailedEvents[0]).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
        'file=/tmp/test/motion/status/contract-observer-state.json',
        'reason=schema_mismatch:shape_mismatch',
      ]),
    );
  });

  it('empty object → throws and audits OBSERVER_STATE_LOAD_FAILED', async () => {
    const fs = makeFsMockWithState(JSON.stringify({}));
    const { audit, events } = makeAuditMock();

    await expect(runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: audit,
      notifyMotion: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Observer state corrupt');

    const loadFailedEvents = events.filter(
      (e) => e[0] === CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
    );
    expect(loadFailedEvents.length).toBe(1);
    expect(loadFailedEvents[0]).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
        'file=/tmp/test/motion/status/contract-observer-state.json',
        'reason=schema_mismatch:shape_mismatch',
      ]),
    );
  });

  it('valid v3 state → no load audit + proceeds', async () => {
    const fs = makeFsMockWithState(JSON.stringify({
      version: 3,
      lastCheckTs: 12345,
      lastArchivedAt: 1000,
      bootstrapDone: true,
    }));
    const { audit, events } = makeAuditMock();

    await runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: audit,
      notifyMotion: vi.fn().mockResolvedValue(undefined),
    });

    const loadFailedEvents = events.filter(
      (e) => e[0] === CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
    );
    expect(loadFailedEvents.length).toBe(0);
  });

  it('read error (non-ENOENT) → throws and audits OBSERVER_STATE_LOAD_FAILED', async () => {
    const fs = makeFsMockWithState('');
    vi.spyOn(fs, 'readSync').mockImplementation(() => {
      const err = new Error('EIO') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });
    const { audit, events } = makeAuditMock();

    await expect(runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: audit,
      notifyMotion: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Observer state corrupt');

    const loadFailedEvents = events.filter(
      (e) => e[0] === CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
    );
    expect(loadFailedEvents.length).toBe(1);
    expect(loadFailedEvents[0]).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
        'file=/tmp/test/motion/status/contract-observer-state.json',
        'reason=read_failed:EIO:[EIO] EIO',
      ]),
    );
  });

  it('JSON parse failure → throws and audits OBSERVER_STATE_LOAD_FAILED', async () => {
    const fs = makeFsMockWithState('not valid json');
    const { audit, events } = makeAuditMock();

    await expect(runContractObserver({
      clawsDir: '/tmp/test/claws',
      clawTopology: makeMockTopology(fs, '/tmp/test/claws'),
      motionDir: '/tmp/test/motion',
      fs,
      motionAudit: audit,
      notifyMotion: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Observer state corrupt');

    const loadFailedEvents = events.filter(
      (e) => e[0] === CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
    );
    expect(loadFailedEvents.length).toBe(1);
    expect(loadFailedEvents[0]).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
        'file=/tmp/test/motion/status/contract-observer-state.json',
      ]),
    );
    expect(loadFailedEvents[0].some(c => String(c).startsWith('reason=json_parse_failed'))).toBe(true);
  });
});
