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

describe('Contract ContractCreationIntentSchema deep surface', () => {
  it('keeps the creation intent zod schema local behind the intent builder', () => {
    expect(creationSource).not.toMatch(/export\s+const\s+ContractCreationIntentSchema\b/);
    expect(creationSource).not.toMatch(/export\s+const\s+VerificationAssetManifestEntrySchema\b/);
    expect(creationSource).toMatch(
      /(?:^|\n)const\s+VerificationAssetManifestEntrySchema\s*=\s*z\.object\(\{\s*\n\s*name:\s*z\.string\(\),\s*\n\s*bytes:\s*z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n(?:\s*\/\/[^\n]*\n)*\s*sha256:\s*z\.string\(\)\.optional\(\),\s*\n\}\)\.strict\(\);/,
    );
    expect(creationSource).toMatch(
      /(?:^|\n)const\s+ContractCreationIntentSchema\s*=\s*z\.object\(\{\s*\n\s*schema_version:\s*z\.literal\(1\),\s*\n\s*contract_id:\s*z\.string\(\),\s*\n\s*started_at:\s*z\.string\(\)\.datetime\(\),\s*\n\s*contract:\s*ContractYamlSchema,\s*\n(?:\s*\/\/[^\n]*\n)*\s*verification_assets:\s*z\.array\(VerificationAssetManifestEntrySchema\)\.optional\(\),\s*\n\}\)\.strict\(\);/,
    );
    expect(creationSource).toMatch(/export\s+function\s+buildCreationIntent\(/);
    expect(barrelSource).not.toMatch(/\bContractCreationIntentSchema\b/);
    expect(barrelSource).not.toMatch(/\bVerificationAssetManifestEntrySchema\b/);
  });
});
