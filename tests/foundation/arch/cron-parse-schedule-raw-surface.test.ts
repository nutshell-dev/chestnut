import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runnerSource = readFileSync(
  new URL('../../../src/foundation/cron/runner.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/cron/index.ts', import.meta.url),
  'utf8',
);

describe('Cron parseScheduleRaw deep surface', () => {
  it('keeps the raw parser local behind the audited parseSchedule wrapper', () => {
    expect(runnerSource).not.toMatch(/export\s+function\s+parseScheduleRaw\b/);
    expect(runnerSource).toMatch(
      /(?:^|\n)function\s+parseScheduleRaw\(s:\s*string\):\s*ParseScheduleResult\s*\{/,
    );
    // full result branches: hourly / daily / interval + three failure reasons
    expect(runnerSource).toMatch(/if\s*\(s\s*===\s*'hourly'\)\s*return\s*\{\s*ok:\s*true,\s*schedule:\s*\{\s*type:\s*'hourly'\s*\}\s*\};/);
    expect(runnerSource).toMatch(/if\s*\(s\.startsWith\('daily:'\)\)\s*\{/);
    expect(runnerSource).toMatch(/if\s*\(s\.startsWith\('interval:'\)\)\s*\{/);
    expect(runnerSource).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*'invalid_daily_time'\s*\};/);
    expect(runnerSource.match(/return\s*\{\s*ok:\s*false,\s*reason:\s*'invalid_interval'\s*\};/g)).toHaveLength(2);
    expect(runnerSource).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*'fallback_hourly'\s*\};/);
    // wrapper binding + audit events
    expect(runnerSource).toMatch(
      /export\s+function\s+parseSchedule\(s:\s*string,\s*sink\?:\s*CronEventSink\):\s*CronSchedule\s*\|\s*null\s*\{\s*\n\s*const\s+r\s*=\s*parseScheduleRaw\(s\);/,
    );
    expect(runnerSource).toMatch(/sink\?\.write\(CRON_AUDIT_EVENTS\.PARSE_INVALID,/);
    expect(runnerSource).toMatch(/sink\?\.write\(CRON_AUDIT_EVENTS\.PARSE_FALLBACK,/);
    // visibility comment no longer steers new code to the deep helper
    expect(runnerSource).not.toMatch(/新代码优先用\s*parseScheduleRaw/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bparseSchedule\b[^}]*\}\s*from\s*'\.\/runner\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bparseScheduleRaw\b/);
  });
});
