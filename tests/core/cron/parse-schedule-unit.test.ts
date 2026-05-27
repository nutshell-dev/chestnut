import { describe, it, expect, vi } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import { parseSchedule } from '../../../src/core/cron/runner.js';

function makeMockAudit() { return { write: vi.fn() }; }

describe('parseSchedule unit strict (phase 1216 r131 B fork)', () => {
  it('parses "interval:30s" → ms=30_000', () => {
    expect(parseSchedule('interval:30s')).toEqual({ type: 'interval', ms: 30_000 });
  });

  it('parses "interval:6h" → ms=21_600_000', () => {
    expect(parseSchedule('interval:6h')).toEqual({ type: 'interval', ms: 21_600_000 });
  });

  it('parses "interval:5m" → ms=300_000 (cascade existing)', () => {
    expect(parseSchedule('interval:5m')).toEqual({ type: 'interval', ms: 300_000 });
  });

  it('rejects "interval:30x" invalid suffix → null + PARSE_INVALID audit', () => {
    const audit = makeMockAudit();
    expect(parseSchedule('interval:30x', audit as unknown as AuditLog)).toBeNull();
    expect(audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.PARSE_INVALID,
      'input=interval:30x',
      'reason=invalid_interval'
    );
  });

  it('rejects "interval:0s" → null + PARSE_INVALID audit', () => {
    const audit = makeMockAudit();
    expect(parseSchedule('interval:0s', audit as unknown as AuditLog)).toBeNull();
    expect(audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.PARSE_INVALID,
      'input=interval:0s',
      'reason=invalid_interval'
    );
  });
});
