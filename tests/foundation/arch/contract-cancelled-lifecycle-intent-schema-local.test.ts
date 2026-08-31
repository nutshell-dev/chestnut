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

describe('Contract CancelledLifecycleIntentSchema deep surface', () => {
  it('keeps the cancelled intent schema owner-local behind the union schema', () => {
    expect(intentSource).not.toMatch(/export\s+const\s+CancelledLifecycleIntentSchema\b/);
    expect(intentSource).toMatch(
      /(?:^|\n)const\s+CancelledLifecycleIntentSchema\s*=\s*BaseLifecycleIntentSchema\.extend\(\{\s*\n\s*requested_state:\s*z\.literal\('cancelled'\),\s*\n\s*reason:\s*z\.string\(\)\.min\(1\),\s*\n\}\)\.strict\(\);/,
    );
    expect(intentSource).toMatch(
      /z\.discriminatedUnion\('requested_state',\s*\[[\s\S]*?CancelledLifecycleIntentSchema,[\s\S]*?\]\)/,
    );
    expect(barrelSource).not.toMatch(/\bCancelledLifecycleIntentSchema\b/);
  });
});
