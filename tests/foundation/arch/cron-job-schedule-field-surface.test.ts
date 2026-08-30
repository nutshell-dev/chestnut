import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSchemaSource = readFileSync(
  new URL('../../../src/foundation/cron/config-schema.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/cron/index.ts', import.meta.url),
  'utf8',
);

describe('Cron cronJobScheduleField deep surface', () => {
  it('keeps the schedule field schema local behind the jobs schema', () => {
    expect(configSchemaSource).not.toMatch(/export\s+const\s+cronJobScheduleField\b/);
    expect(configSchemaSource).toMatch(
      /(?:^|\n)const\s+cronJobScheduleField\s*=\s*z\.string\(\)\.regex\(SCHEDULE_REGEX\);/,
    );
    const reusePoints = configSchemaSource.match(
      /schedule:\s*cronJobScheduleField\.default\('(?:hourly|daily:\d{1,2}:\d{2}|interval:\d+[smh])'\),/g,
    );
    expect(reusePoints).toHaveLength(4);
    expect(configSchemaSource).toMatch(/schedule:\s*cronJobScheduleField\.default\('daily:04:00'\),/);
    expect(configSchemaSource).toMatch(/schedule:\s*cronJobScheduleField\.default\('interval:1s'\),/);
    expect(configSchemaSource).toMatch(/schedule:\s*cronJobScheduleField\.default\('interval:1h'\),/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bcronConfigSchema\b[^}]*\}\s*from\s*'\.\/config-schema\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bcronJobScheduleField\b/);
  });
});
