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

describe('Contract events guidance decode error reason deep surface', () => {
  it('keeps the decode error reason union local behind the decode error class', () => {
    expect(codecSource).not.toMatch(/export\s+type\s+ContractEventsGuidanceDecodeErrorReason\b/);
    expect(codecSource).toMatch(
      /(?:^|\n)type\s+ContractEventsGuidanceDecodeErrorReason\s*=\s*\n\s*\|\s*'unknown_schema_version'\s*\n\s*\|\s*'schema_invalid';/,
    );
    expect(codecSource).toMatch(
      /export\s+class\s+ContractEventsGuidanceDecodeError\s+extends\s+Error\s*\{\s*\n\s*readonly\s+reason:\s*ContractEventsGuidanceDecodeErrorReason;/,
    );
    expect(barrelSource).not.toMatch(/\bContractEventsGuidanceDecodeErrorReason\b/);
  });
});
