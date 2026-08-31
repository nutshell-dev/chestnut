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

describe('Contract FootprintRead deep surface', () => {
  it('keeps the footprint read leaf type local inside the footprint aggregate', () => {
    expect(footprintSource).not.toMatch(/export\s+interface\s+FootprintRead\b/);
    expect(footprintSource).toMatch(
      /(?:^|\n)interface\s+FootprintRead\s*\{\s*\n\s*file:\s*string;\s*\n\s*step:\s*number;\s*\n\}/,
    );
    expect(footprintSource).toMatch(/export\s+interface\s+ContractFootprint\s*\{/);
    expect(footprintSource).toMatch(/\breads:\s*FootprintRead\[\]/);
    expect(barrelSource).not.toMatch(/\bFootprintRead\b/);
  });
});
