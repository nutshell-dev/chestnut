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

describe('Contract ContractCreationIntent deep surface', () => {
  it('keeps the creation intent type local behind the serializer', () => {
    expect(creationSource).not.toMatch(/export\s+type\s+ContractCreationIntent\b/);
    expect(creationSource).toMatch(
      /(?:^|\n)type\s+ContractCreationIntent\s*=\s*z\.infer<typeof\s+ContractCreationIntentSchema>;/,
    );
    expect(creationSource).toMatch(
      /export\s+function\s+serializeCreationIntent\(intent:\s*ContractCreationIntent\):\s*string/,
    );
    expect(barrelSource).not.toMatch(/\bContractCreationIntent\b/);
  });
});
