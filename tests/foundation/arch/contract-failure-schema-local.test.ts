import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const intentSource = readFileSync(
  new URL('../../../src/core/contract/lifecycle-intent.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract ContractFailureSchema deep surface', () => {
  it('keeps the failure payload schema owner-local behind the failed intent schema', () => {
    expect(intentSource).not.toMatch(/export\s+const\s+ContractFailureSchema\b/);
    expect(intentSource).toMatch(
      /(?:^|\n)const\s+ContractFailureSchema\s*=\s*z\.object\(\{\s*\n\s*reason:\s*z\.string\(\)\.min\(1\),\s*\n\s*evidenceRef:\s*z\.string\(\)\.min\(1\),\s*\n\s*producer:\s*z\.string\(\)\.min\(1\),\s*\n\}\)\.strict\(\);/,
    );
    expect(intentSource).toMatch(
      /FailedLifecycleIntentSchema\s*=\s*BaseLifecycleIntentSchema\.extend\(\{\s*\n\s*requested_state:\s*z\.literal\('failed'\),\s*\n\s*failure:\s*ContractFailureSchema,\s*\n\}\)\.strict\(\);/,
    );
    expect(barrelSource).not.toMatch(/\bContractFailureSchema\b/);
  });
});
