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

describe('Contract events guidance state deep surface', () => {
  it('keeps the decoded state type local behind the decode function', () => {
    expect(codecSource).not.toMatch(/export\s+interface\s+ContractEventsGuidanceState\b/);
    expect(codecSource).toMatch(
      /(?:^|\n)interface\s+ContractEventsGuidanceState\s*\{\s*\n\s*readonly\s+schemaVersion:\s*1;\s*\n\s*readonly\s+contractRefs:\s*readonly\s+ContractEventGuidanceRef\[\];\s*\n\}/,
    );
    expect(codecSource).toMatch(
      /export\s+function\s+decodeContractEventsGuidance\(\s*\n\s*input:\s*ContractEventsGuidanceWire,\s*\n\):\s*ContractEventsGuidanceState\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bContractEventsGuidanceState\b/);
  });
});
