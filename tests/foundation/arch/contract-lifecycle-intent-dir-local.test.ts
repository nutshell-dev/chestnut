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

describe('Contract lifecycleIntentDir deep surface', () => {
  it('keeps the intent dir helper owner-local behind the intent path entry', () => {
    expect(intentSource).not.toMatch(/export\s+function\s+lifecycleIntentDir\b/);
    expect(intentSource).toMatch(
      /(?:^|\n)function\s+lifecycleIntentDir\(baseDir:\s*string,\s*contractId:\s*ContractId\):\s*string\s*\{\s*\n\s*return\s*path\.join\(baseDir,\s*CONTRACT_LIFECYCLE_INTENTS_DIR,\s*contractId\);\s*\n\}/,
    );
    expect(intentSource).toMatch(
      /path\.join\(lifecycleIntentDir\(baseDir,\s*contractId\),\s*`\$\{requestId\}\.json`\)/,
    );
    expect(intentSource).toMatch(/export\s+function\s+lifecycleIntentPath\b/);
    expect(barrelSource).not.toMatch(/\blifecycleIntentDir\b/);
  });
});
