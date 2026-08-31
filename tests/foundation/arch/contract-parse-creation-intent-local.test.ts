import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const creationSource = readFileSync(
  new URL('../../../src/core/contract/creation.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract parseCreationIntent deep surface', () => {
  it('keeps the creation intent parser local behind the recovery flow', () => {
    expect(creationSource).not.toMatch(/export\s+function\s+parseCreationIntent\b/);
    expect(creationSource).toMatch(
      /(?:^|\n)function\s+parseCreationIntent\(raw:\s*string\):\s*ContractCreationIntent\s*\|\s*null\s*\{/,
    );
    expect(creationSource).toMatch(/const\s+intent\s*=\s*parseCreationIntent\(raw\);/);
    expect(creationSource).toMatch(/export\s+function\s+serializeCreationIntent\(/);
    expect(barrelSource).not.toMatch(/\bparseCreationIntent\b/);
  });
});
