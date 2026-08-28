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

describe('ProcessManager PROCESS_DIR_NAME deep surface', () => {
  it('keeps the generation root dir name local behind the path helpers', () => {
    expect(generationSource).not.toMatch(/export\s+const\s+PROCESS_DIR_NAME\b/);
    expect(generationSource).toMatch(/(?:^|\n)const\s+PROCESS_DIR_NAME\s*=\s*'process';/);
    expect(generationSource).toMatch(
      /path\.join\(daemonDir,\s*STATUS_SUBDIR,\s*PROCESS_DIR_NAME\)/,
    );
    expect(barrelSource).not.toMatch(/\bPROCESS_DIR_NAME\b/);
  });
});
