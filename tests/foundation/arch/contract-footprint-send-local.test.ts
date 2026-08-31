import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const footprintSource = readFileSync(
  new URL('../../../src/core/contract/contract-footprint.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract FootprintSend deep surface', () => {
  it('keeps the footprint send leaf type local inside the footprint aggregate', () => {
    expect(footprintSource).not.toMatch(/export\s+interface\s+FootprintSend\b/);
    expect(footprintSource).toMatch(
      /(?:^|\n)interface\s+FootprintSend\s*\{\s*\n\s*to:\s*string;\s*\n\s*step:\s*number;\s*\n\}/,
    );
    expect(footprintSource).toMatch(/export\s+interface\s+ContractFootprint\s*\{/);
    expect(footprintSource).toMatch(/\bsends:\s*FootprintSend\[\]/);
    expect(barrelSource).not.toMatch(/\bFootprintSend\b/);
  });
});
