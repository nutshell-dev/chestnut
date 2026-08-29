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

describe('ProcessManager StopIntentRecord deep surface', () => {
  it('keeps the stop intent record interface local behind write/scan operations', () => {
    expect(generationSource).not.toMatch(/export\s+interface\s+StopIntentRecord\b/);
    expect(generationSource).toMatch(
      /(?:^|\n)interface\s+StopIntentRecord\s*\{[\s\S]*?request_id:\s*string;[\s\S]*?target_generation_id:\s*string;[\s\S]*?\}/,
    );
    expect(generationSource).toMatch(/function\s+isStopIntentRecord\(parsed:\s*unknown\):\s*parsed\s+is\s+StopIntentRecord/);
    expect(generationSource).toMatch(/export\s+function\s+writeStopIntent\(/);
    expect(generationSource).toMatch(/export\s+function\s+scanStopIntentsForGeneration\(/);
    expect(barrelSource).not.toMatch(/\bStopIntentRecord\b/);
  });
});
