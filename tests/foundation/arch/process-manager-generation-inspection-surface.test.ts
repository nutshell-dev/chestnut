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

describe('ProcessManager GenerationInspection deep surface', () => {
  it('keeps the generation inspection outcome type local behind public inspection helpers', () => {
    expect(generationSource).not.toMatch(/export\s+type\s+GenerationInspection\b/);
    expect(generationSource).toMatch(/(?:^|\n)type\s+GenerationInspection\s*=/);
    expect(generationSource).toMatch(/export\s+function\s+inspectSpawning\(/);
    expect(generationSource).toMatch(/export\s+function\s+inspectActive\(/);
    expect(generationSource).toMatch(/\):\s*GenerationInspection\s*\{/g);
    expect(barrelSource).not.toMatch(/\bGenerationInspection\b/);
  });
});
