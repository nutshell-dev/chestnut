import { describe, it, expect, vi } from 'vitest';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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

function makeAuditMock(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
  return { audit, events };
}

describe('contract observer state file shape_mismatch emits OBSERVER_STATE_PARSE_FAILED (phase 1012)', () => {
  it('lastCheckTs string → audit OBSERVER_STATE_PARSE_FAILED + fallback lastCheckTs=0', async () => {
    const fs = makeFsMockWithState(JSON.stringify({ lastCheckTs: 'abc' }));
    const { audit, events } = makeAuditMock();

    await runContractObserver({
      clawforumRoot: '/tmp/test',
      fs,
      motionAudit: audit,
      notifyClaw: vi.fn(),
    });

    const parseFailedEvents = events.filter(
      (e) => e[0] === CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_PARSE_FAILED,
    );
    expect(parseFailedEvents.length).toBe(1);
    expect(parseFailedEvents[0]).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_PARSE_FAILED,
        'reason=shape_mismatch',
        'stateFile=/tmp/test/motion/status/contract-observer-state.json',
      ]),
    );
  });

  it('empty object → audit OBSERVER_STATE_PARSE_FAILED + fallback lastCheckTs=0', async () => {
    const fs = makeFsMockWithState(JSON.stringify({}));
    const { audit, events } = makeAuditMock();

    await runContractObserver({
      clawforumRoot: '/tmp/test',
      fs,
      motionAudit: audit,
      notifyClaw: vi.fn(),
    });

    const parseFailedEvents = events.filter(
      (e) => e[0] === CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_PARSE_FAILED,
    );
    expect(parseFailedEvents.length).toBe(1);
    expect(parseFailedEvents[0]).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_PARSE_FAILED,
        'reason=shape_mismatch',
      ]),
    );
  });

  it('valid number lastCheckTs → no audit + uses value', async () => {
    const fs = makeFsMockWithState(JSON.stringify({ lastCheckTs: 12345 }));
    const { audit, events } = makeAuditMock();

    await runContractObserver({
      clawforumRoot: '/tmp/test',
      fs,
      motionAudit: audit,
      notifyClaw: vi.fn(),
    });

    const parseFailedEvents = events.filter(
      (e) => e[0] === CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_PARSE_FAILED,
    );
    expect(parseFailedEvents.length).toBe(0);
  });
});
