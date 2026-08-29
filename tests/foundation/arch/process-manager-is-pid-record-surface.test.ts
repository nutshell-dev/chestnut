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

describe('ProcessManager isPidRecord deep surface', () => {
  it('keeps the PID record type guard local behind the public inspection helpers', () => {
    expect(generationSource).not.toMatch(/export\s+function\s+isPidRecord\b/);
    expect(generationSource).toMatch(
      /(?:^|\n)function\s+isPidRecord\(parsed:\s*unknown\):\s*parsed\s+is\s+ProcessPidRecord\s*\{/,
    );
    expect(generationSource).toMatch(
      /if\s*\(\s*!isPidRecord\(parsed\)\)\s*return\s*\{\s*status:\s*'malformed',\s*cause:\s*'pid_shape_mismatch'\s*\}/,
    );
    expect(generationSource).toMatch(
      /if\s*\(\s*!isPidRecord\(parsed\)\)\s*return\s*\{\s*status:\s*'malformed',\s*cause:\s*'ready_shape_mismatch'\s*\}/,
    );
    expect(barrelSource).not.toMatch(/\bisPidRecord\b/);
  });
});
