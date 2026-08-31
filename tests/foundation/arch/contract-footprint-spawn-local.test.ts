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

describe('Contract FootprintSpawn deep surface', () => {
  it('keeps the footprint spawn leaf type local inside the footprint aggregate', () => {
    expect(footprintSource).not.toMatch(/export\s+interface\s+FootprintSpawn\b/);
    expect(footprintSource).toMatch(
      /(?:^|\n)interface\s+FootprintSpawn\s*\{\s*\n\s*taskId:\s*string;\s*\n\s*step:\s*number;\s*\n\}/,
    );
    expect(footprintSource).toMatch(/export\s+interface\s+ContractFootprint\s*\{/);
    expect(footprintSource).toMatch(/\bspawns:\s*FootprintSpawn\[\]/);
    expect(barrelSource).not.toMatch(/\bFootprintSpawn\b/);
  });
});
