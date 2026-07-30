import { describe, it, expect, vi } from 'vitest';
import type { CronEventSink } from '../../../src/foundation/cron/runner.js';
import { CRON_AUDIT_EVENTS } from '../../../src/foundation/cron/audit-events.js';
import { parseSchedule } from '../../../src/foundation/cron/runner.js';

function makeMockSink(): CronEventSink { return { write: vi.fn() }; }

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
    const sink = makeMockSink();
    expect(parseSchedule('interval:30x', sink)).toBeNull();
    expect(sink.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.PARSE_INVALID,
      'input=interval:30x',
      'reason=invalid_interval'
    );
  });

  it('rejects "interval:0s" → null + PARSE_INVALID audit', () => {
    const sink = makeMockSink();
    expect(parseSchedule('interval:0s', sink)).toBeNull();
    expect(sink.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.PARSE_INVALID,
      'input=interval:0s',
      'reason=invalid_interval'
    );
  });
});
