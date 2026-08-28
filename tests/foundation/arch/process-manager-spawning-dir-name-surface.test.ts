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

describe('ProcessManager SPAWNING_DIR_NAME deep surface', () => {
  it('keeps the spawning dir name local behind the path helpers', () => {
    expect(generationSource).not.toMatch(/export\s+const\s+SPAWNING_DIR_NAME\b/);
    expect(generationSource).toMatch(/(?:^|\n)const\s+SPAWNING_DIR_NAME\s*=\s*'spawning';/);
    expect(generationSource).toMatch(
      /path\.join\(getProcessDir\(daemonDir\),\s*SPAWNING_DIR_NAME\)/,
    );
    expect(barrelSource).not.toMatch(/\bSPAWNING_DIR_NAME\b/);
  });
});
