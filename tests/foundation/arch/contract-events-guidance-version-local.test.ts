import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const codecSource = readFileSync(
  new URL('../../../src/core/contract/contract-events-guidance.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract events guidance schema version deep surface', () => {
  it('keeps the schema version constant local behind the codec functions', () => {
    expect(codecSource).not.toMatch(/export\s+const\s+CONTRACT_EVENTS_GUIDANCE_SCHEMA_VERSION\b/);
    expect(codecSource).toMatch(
      /(?:^|\n)const\s+CONTRACT_EVENTS_GUIDANCE_SCHEMA_VERSION\s*=\s*'1'\s+as\s+const;/,
    );
    expect(codecSource).toMatch(/export\s+function\s+encodeContractEventsGuidance\(/);
    expect(codecSource).toMatch(/export\s+function\s+decodeContractEventsGuidance\(/);
    expect(barrelSource).not.toMatch(/\bCONTRACT_EVENTS_GUIDANCE_SCHEMA_VERSION\b/);
  });
});
