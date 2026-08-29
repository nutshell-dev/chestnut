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

describe('ProcessManager GenerationIdentity deep surface', () => {
  it('keeps the generation identity interface local behind activateGeneration', () => {
    expect(generationSource).not.toMatch(/export\s+interface\s+GenerationIdentity\b/);
    expect(generationSource).toMatch(
      /(?:^|\n)interface\s+GenerationIdentity\s*\{[\s\S]*?generationId:\s*string;[\s\S]*?pid:\s*number;[\s\S]*?startTime\?:\s*ProcessStartTime;[\s\S]*?\}/,
    );
    expect(generationSource).toMatch(/expected:\s*GenerationIdentity,/);
    expect(barrelSource).not.toMatch(/\bGenerationIdentity\b/);
  });
});
