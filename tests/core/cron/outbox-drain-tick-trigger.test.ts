import { describe, it, expect, vi } from 'vitest';
import { runOutboxDrain, DEFAULT_LIMIT_PER_CLAW } from '../../../src/core/cron/jobs/outbox-drain.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import { execSync } from 'node:child_process';

describe('phase 1333 outbox-drain cron tick trigger 退化', () => {
  it('cron job 0 直访 claws/* / mock messaging.drainOutboxes call count + signature', async () => {
    const mockMessaging = {
      drainOutboxes: vi.fn().mockResolvedValue({ delivered: 5, failed: 0 }),
    };
    const auditCalls: string[] = [];
    const mockAudit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push(`${type}:${cols.join(',')}`);
      },
    };

    await runOutboxDrain({ messaging: mockMessaging, limitPerClaw: 10, audit: mockAudit });

    expect(mockMessaging.drainOutboxes).toHaveBeenCalledOnce();
    expect(mockMessaging.drainOutboxes).toHaveBeenCalledWith({ limitPerClaw: 10, signal: undefined });

    // verify cron audit summary emitted
    const doneEvents = auditCalls.filter(c => c.startsWith(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE));
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0]).toContain('total=5');
    expect(doneEvents[0]).toContain('failed=0');
  });

  it('drain throw → cron audit emit + rethrow', async () => {
    const mockMessaging = {
      drainOutboxes: vi.fn().mockRejectedValue(new Error('drain fail')),
    };
    const auditCalls: string[] = [];
    const mockAudit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push(`${type}:${cols.join(',')}`);
      },
    };

    await expect(
      runOutboxDrain({ messaging: mockMessaging, audit: mockAudit }),
    ).rejects.toThrow('drain fail');

    const failedEvents = auditCalls.filter(c => c.startsWith(CRON_AUDIT_EVENTS.OUTBOX_DRAIN_FAILED));
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0]).toContain('reason=drain_threw');
    expect(failedEvents[0]).toContain('error=drain fail');
  });

  it('grep ban: cron job no raw fs.writeAtomic.*inbox in src/core/cron/jobs/outbox-drain.ts', () => {
    const srcRoot = new URL('../../../src', import.meta.url).pathname;
    const out = execSync(
      `grep -cE "fs\\.writeAtomic.*inbox" ${srcRoot}/core/cron/jobs/outbox-drain.ts || true`,
      { encoding: 'utf-8' },
    ).trim();
    expect(out).toBe('0');
  });
});
