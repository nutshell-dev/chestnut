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

describe('Contract FootprintWrite deep surface', () => {
  it('keeps the footprint write leaf type local inside the footprint aggregate', () => {
    expect(footprintSource).not.toMatch(/export\s+interface\s+FootprintWrite\b/);
    expect(footprintSource).toMatch(
      /(?:^|\n)interface\s+FootprintWrite\s*\{\s*\n\s*file:\s*string;\s*\n\s*bytes:\s*number;\s*\n\s*step:\s*number;\s*\n\}/,
    );
    expect(footprintSource).toMatch(/export\s+interface\s+ContractFootprint\s*\{/);
    expect(footprintSource).toMatch(/\bwrites:\s*FootprintWrite\[\]/);
    expect(barrelSource).not.toMatch(/\bFootprintWrite\b/);
  });
});
