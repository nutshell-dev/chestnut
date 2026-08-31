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

describe('Contract CorruptedLifecycleIntentSchema deep surface', () => {
  it('keeps the corrupted intent schema owner-local behind the union schema', () => {
    expect(intentSource).not.toMatch(/export\s+const\s+CorruptedLifecycleIntentSchema\b/);
    expect(intentSource).toMatch(
      /(?:^|\n)const\s+CorruptedLifecycleIntentSchema\s*=\s*BaseLifecycleIntentSchema\.extend\(\{\s*\n\s*requested_state:\s*z\.literal\('corrupted'\),\s*\n\s*evidence:\s*ContractCorruptionEvidenceSchema,\s*\n\}\)\.strict\(\);/,
    );
    expect(intentSource).toMatch(
      /z\.discriminatedUnion\('requested_state',\s*\[[\s\S]*?CorruptedLifecycleIntentSchema,[\s\S]*?\]\)/,
    );
    expect(barrelSource).not.toMatch(/\bCorruptedLifecycleIntentSchema\b/);
  });
});
