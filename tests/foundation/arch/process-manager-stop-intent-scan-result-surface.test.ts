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

describe('ProcessManager StopIntentScanResult deep surface', () => {
  it('keeps the stop intent scan outcome type local behind scanStopIntentsForGeneration', () => {
    expect(generationSource).not.toMatch(/export\s+type\s+StopIntentScanResult\b/);
    expect(generationSource).toMatch(/(?:^|\n)type\s+StopIntentScanResult\s*=/);
    expect(generationSource).toMatch(/export\s+function\s+scanStopIntentsForGeneration\(/);
    expect(generationSource).toMatch(/\):\s*StopIntentScanResult\s*\{/);
    expect(barrelSource).not.toMatch(/\bStopIntentScanResult\b/);
  });
});
