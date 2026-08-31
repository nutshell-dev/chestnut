import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const codecSource = readFileSync(
  new URL('../../../src/core/contract/contract-cancelled-guidance.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract cancelled guidance state deep surface', () => {
  it('keeps the decoded state type local behind the decode function', () => {
    expect(codecSource).not.toMatch(/export\s+interface\s+ContractCancelledGuidanceState\b/);
    expect(codecSource).toMatch(
      /(?:^|\n)interface\s+ContractCancelledGuidanceState\s*\{\s*\n\s*readonly\s+schemaVersion:\s*1;\s*\n\s*readonly\s+contractRefs:\s*readonly\s+ContractCancelledGuidanceRef\[\];\s*\n\}/,
    );
    expect(codecSource).toMatch(
      /export\s+function\s+decodeContractCancelledGuidance\(\s*\n\s*input:\s*ContractCancelledGuidanceWire,\s*\n\):\s*ContractCancelledGuidanceState\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bContractCancelledGuidanceState\b/);
  });
});
