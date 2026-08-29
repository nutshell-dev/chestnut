import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const generationSource = readFileSync(
  new URL('../../../src/foundation/process-manager/generation.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/process-manager/index.ts', import.meta.url),
  'utf8',
);

describe('ProcessManager isFailureRecord deep surface', () => {
  it('keeps the failure record type guard local behind the public inspection helpers', () => {
    expect(generationSource).not.toMatch(/export\s+function\s+isFailureRecord\b/);
    expect(generationSource).toMatch(
      /(?:^|\n)function\s+isFailureRecord\(parsed:\s*unknown\):\s*parsed\s+is\s+ProcessFailureRecord\s*\{/,
    );
    expect(generationSource).toMatch(
      /if\s*\(\s*!isFailureRecord\(parsed\)\)\s*return\s*\{\s*status:\s*'malformed',\s*cause:\s*'failure_shape_mismatch'\s*\}/,
    );
    expect(barrelSource).not.toMatch(/\bisFailureRecord\b/);
  });
});
