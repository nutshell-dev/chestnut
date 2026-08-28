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

describe('ProcessManager ACTIVE_DIR_NAME deep surface', () => {
  it('keeps the active dir name local behind the public getActiveDir helper', () => {
    expect(generationSource).not.toMatch(/export\s+const\s+ACTIVE_DIR_NAME\b/);
    expect(generationSource).toMatch(/(?:^|\n)const\s+ACTIVE_DIR_NAME\s*=\s*'active';/);
    expect(generationSource).toMatch(
      /path\.join\(getProcessDir\(daemonDir\),\s*ACTIVE_DIR_NAME\)/,
    );
    expect(barrelSource).toMatch(/export\s*\{[^}]*\bgetActiveDir\b[^}]*\}\s*from\s*'\.\/generation\.js';/);
    expect(barrelSource).not.toMatch(/\bACTIVE_DIR_NAME\b/);
  });
});
