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

describe('ProcessManager ProcessReadyRecord deep surface', () => {
  it('keeps the ready record type alias local behind readiness inspection helpers', () => {
    expect(generationSource).not.toMatch(/export\s+type\s+ProcessReadyRecord\b/);
    expect(generationSource).toMatch(/(?:^|\n)type\s+ProcessReadyRecord\s*=\s*ProcessPidRecord;/);
    expect(generationSource).toMatch(/export\s+function\s+inspectSpawningReady\(/);
    expect(generationSource).toMatch(/export\s+function\s+inspectActiveReady\(/);
    expect(generationSource).toMatch(/record:\s*ProcessReadyRecord/g);
    expect(barrelSource).not.toMatch(/\bProcessReadyRecord\b/);
  });
});
