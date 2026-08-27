import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSchemaSource = readFileSync(
  new URL('../../../src/foundation/stream/config-schema.ts', import.meta.url),
  'utf8',
);

describe('Stream StreamConfig dead surface', () => {
  it('does not retain the zero-caller inferred config type', () => {
    expect(configSchemaSource).not.toMatch(/\bStreamConfig\b/);
  });
});
