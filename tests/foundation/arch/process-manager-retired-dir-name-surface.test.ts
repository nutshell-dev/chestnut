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

describe('ProcessManager RETIRED_DIR_NAME deep surface', () => {
  it('keeps the retired dir name local behind the path helpers', () => {
    expect(generationSource).not.toMatch(/export\s+const\s+RETIRED_DIR_NAME\b/);
    expect(generationSource).toMatch(/(?:^|\n)const\s+RETIRED_DIR_NAME\s*=\s*'retired';/);
    expect(generationSource).toMatch(
      /path\.join\(getProcessDir\(daemonDir\),\s*RETIRED_DIR_NAME,\s*generationId\)/,
    );
    expect(barrelSource).not.toMatch(/\bRETIRED_DIR_NAME\b/);
  });
});
