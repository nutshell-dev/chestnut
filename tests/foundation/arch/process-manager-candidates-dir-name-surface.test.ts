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

describe('ProcessManager CANDIDATES_DIR_NAME deep surface', () => {
  it('keeps the candidates dir name local behind the path helpers', () => {
    expect(generationSource).not.toMatch(/export\s+const\s+CANDIDATES_DIR_NAME\b/);
    expect(generationSource).toMatch(/(?:^|\n)const\s+CANDIDATES_DIR_NAME\s*=\s*'candidates';/);
    expect(generationSource).toMatch(
      /path\.join\(getProcessDir\(daemonDir\),\s*CANDIDATES_DIR_NAME\)/,
    );
    expect(barrelSource).not.toMatch(/\bCANDIDATES_DIR_NAME\b/);
  });
});
