import { describe, it, expect, vi } from 'vitest';
import { runSunsetMonitor } from '../../../src/core/cron/jobs/sunset-monitor.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { InboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeMockAudit } from '../../helpers/audit.js';

function makeFsMock(auditContent: string): FileSystem {
  return {
    readSync: vi.fn(() => auditContent),
  } as unknown as FileSystem;
}

function makeInboxMock(): InboxWriter {
  return { writeSync: vi.fn() } as unknown as InboxWriter;
}

function makeOpts(overrides: Partial<{
  fs: FileSystem;
  audit: AuditLog;
  motionInbox: InboxWriter;
  legacyConsts: string[];
}> = {}) {
  return {
    clawforumRoot: '/tmp/test',
    motionAuditPath: '/tmp/test/motion/audit.tsv',
    rootAuditPath: '/tmp/test/audit.tsv',
    legacyConsts: ['legacy_pending_task_no_mode'],
    fs: makeFsMock(''),
    audit: makeMockAudit(),
    motionInbox: makeInboxMock(),
    ...overrides,
  };
}

describe('sunset-monitor', () => {
  it('0 hit emit SUNSET_READY + inbox notify', async () => {
    const opts = makeOpts({
      fs: makeFsMock(''),
    });
    await runSunsetMonitor(opts);
    expect(opts.audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.SUNSET_READY,
      'const=legacy_pending_task_no_mode',
      expect.stringContaining('threshold_days='),
    );
    expect(opts.motionInbox.writeSync).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sunset_ready' }),
    );
  });

  it('≥1 hit 不 emit SUNSET_READY', async () => {
    const ts = new Date().toISOString();
    const content = `${ts}\tseq=1\tlegacy_pending_task_no_mode\tfile=/test.json\n`;
    const opts = makeOpts({
      fs: makeFsMock(content),
    });
    await runSunsetMonitor(opts);
    expect(opts.audit.write).not.toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.SUNSET_READY,
      expect.anything(),
      expect.anything(),
    );
    expect(opts.motionInbox.writeSync).not.toHaveBeenCalled();
  });

  it('query fail emit SUNSET_QUERY_FAIL', async () => {
    const fsMock = {
      readSync: vi.fn(() => {
        throw new Error('permission denied');
      }),
    } as unknown as FileSystem;
    const opts = makeOpts({ fs: fsMock });
    await runSunsetMonitor(opts);
    expect(opts.audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.SUNSET_QUERY_FAIL,
      'const=legacy_pending_task_no_mode',
      expect.stringContaining('err='),
    );
  });
});
