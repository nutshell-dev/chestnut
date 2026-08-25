import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSchemaSource = readFileSync(
  new URL('../../../src/foundation/cron/config-schema.ts', import.meta.url),
  'utf8',
);

describe('Cron CronConfig dead surface', () => {
  it('does not retain the zero-caller inferred config type', () => {
    expect(configSchemaSource).not.toMatch(/\bCronConfig\b/);
  });
});
