import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const intentSource = readFileSync(
  new URL('../../../src/core/contract/lifecycle-intent.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract LIFECYCLE_INTENT_SCHEMA_VERSION deep surface', () => {
  it('keeps the persisted intent schema version owner-local behind the intent schemas', () => {
    expect(intentSource).not.toMatch(/export\s+const\s+LIFECYCLE_INTENT_SCHEMA_VERSION\b/);
    expect(intentSource).toMatch(
      /(?:^|\n)const\s+LIFECYCLE_INTENT_SCHEMA_VERSION\s*=\s*1\s+as\s+const;/,
    );
    expect(intentSource).toMatch(
      /schema_version:\s*z\.literal\(LIFECYCLE_INTENT_SCHEMA_VERSION\),/,
    );
    expect(
      intentSource.match(/schema_version:\s*LIFECYCLE_INTENT_SCHEMA_VERSION,/g) ?? [],
    ).toHaveLength(4);
    expect(barrelSource).not.toMatch(/\bLIFECYCLE_INTENT_SCHEMA_VERSION\b/);
  });
});
