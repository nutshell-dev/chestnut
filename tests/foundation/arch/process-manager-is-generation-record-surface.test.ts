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

describe('ProcessManager isGenerationRecord deep surface', () => {
  it('keeps the generation record type guard local behind the public inspection helpers', () => {
    expect(generationSource).not.toMatch(/export\s+function\s+isGenerationRecord\b/);
    expect(generationSource).toMatch(
      /(?:^|\n)function\s+isGenerationRecord\(parsed:\s*unknown\):\s*parsed\s+is\s+ProcessGenerationRecord\s*\{/,
    );
    expect(generationSource).toMatch(
      /if\s*\(\s*!isGenerationRecord\(parsed\)\)\s*return\s*\{\s*status:\s*'malformed'/,
    );
    expect(generationSource).toMatch(
      /p\.schema_version\s*===\s*PROCESS_GENERATION_SCHEMA_VERSION/,
    );
    expect(barrelSource).not.toMatch(/\bisGenerationRecord\b/);
  });
});
