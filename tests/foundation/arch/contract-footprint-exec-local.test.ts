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

describe('Contract FootprintExec deep surface', () => {
  it('keeps the footprint exec leaf type local inside the footprint aggregate', () => {
    expect(footprintSource).not.toMatch(/export\s+interface\s+FootprintExec\b/);
    expect(footprintSource).toMatch(
      /(?:^|\n)interface\s+FootprintExec\s*\{\s*\n\s*command:\s*string;\s*\n\s*exitCode:\s*number;\s*\n\s*step:\s*number;\s*\n\}/,
    );
    expect(footprintSource).toMatch(/export\s+interface\s+ContractFootprint\s*\{/);
    expect(footprintSource).toMatch(/\bexecCommands:\s*FootprintExec\[\]/);
    expect(barrelSource).not.toMatch(/\bFootprintExec\b/);
  });
});
