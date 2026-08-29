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

describe('ProcessManager WriteStopIntentResult deep surface', () => {
  it('keeps the write stop intent outcome type local behind writeStopIntent', () => {
    expect(generationSource).not.toMatch(/export\s+type\s+WriteStopIntentResult\b/);
    expect(generationSource).toMatch(/(?:^|\n)type\s+WriteStopIntentResult\s*=/);
    expect(generationSource).toMatch(/export\s+function\s+writeStopIntent\(/);
    expect(generationSource).toMatch(/\):\s*WriteStopIntentResult\s*\{/);
    expect(barrelSource).not.toMatch(/\bWriteStopIntentResult\b/);
  });
});
