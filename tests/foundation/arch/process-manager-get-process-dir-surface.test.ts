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

describe('ProcessManager getProcessDir deep surface', () => {
  it('keeps the process root path helper local behind public subdir helpers', () => {
    expect(generationSource).not.toMatch(/export\s+function\s+getProcessDir\b/);
    expect(generationSource).toMatch(/(?:^|\n)function\s+getProcessDir\(daemonDir:\s*DaemonDir\):\s*string\s*\{/);
    expect(generationSource).toMatch(/path\.join\(getProcessDir\(daemonDir\),\s*CANDIDATES_DIR_NAME\)/);
    expect(generationSource).toMatch(/path\.join\(getProcessDir\(daemonDir\),\s*SPAWNING_DIR_NAME\)/);
    expect(generationSource).toMatch(/path\.join\(getProcessDir\(daemonDir\),\s*ACTIVE_DIR_NAME\)/);
    expect(generationSource).toMatch(/path\.join\(getProcessDir\(daemonDir\),\s*RETIRED_DIR_NAME,\s*generationId\)/);
    expect(generationSource).toMatch(/path\.join\(getProcessDir\(daemonDir\),\s*STOP_INTENTS_DIR_NAME\)/);
    expect(barrelSource).not.toMatch(/\bgetProcessDir\b/);
  });
});
