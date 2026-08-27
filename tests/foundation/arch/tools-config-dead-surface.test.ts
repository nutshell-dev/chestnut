import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSchemaSource = readFileSync(
  new URL('../../../src/foundation/tools/config-schema.ts', import.meta.url),
  'utf8',
);

describe('Tools ToolsConfig dead surface', () => {
  it('does not retain the zero-caller inferred config type', () => {
    expect(configSchemaSource).not.toMatch(/\bToolsConfig\b/);
  });
});
