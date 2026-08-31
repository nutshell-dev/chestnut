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

describe('Contract LifecycleIntentSchema deep surface', () => {
  it('keeps the intent union schema owner-local behind the intent readers', () => {
    expect(intentSource).not.toMatch(/export\s+const\s+LifecycleIntentSchema\b/);
    expect(intentSource).toMatch(
      /(?:^|\n)const\s+LifecycleIntentSchema\s*=\s*z\.discriminatedUnion\('requested_state',\s*\[\s*\n\s*CompletedLifecycleIntentSchema,\s*\n\s*CancelledLifecycleIntentSchema,\s*\n\s*CorruptedLifecycleIntentSchema,\s*\n\s*FailedLifecycleIntentSchema,\s*\n\]\);/,
    );
    expect(
      intentSource.match(/LifecycleIntentSchema\.safeParse\(/g) ?? [],
    ).toHaveLength(2);
    expect(barrelSource).not.toMatch(/\bLifecycleIntentSchema\b/);
  });
});
