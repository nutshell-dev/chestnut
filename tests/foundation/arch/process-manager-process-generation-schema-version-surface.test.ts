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

describe('ProcessManager PROCESS_GENERATION_SCHEMA_VERSION deep surface', () => {
  it('keeps the generation schema version local behind record/guards', () => {
    expect(generationSource).not.toMatch(/export\s+const\s+PROCESS_GENERATION_SCHEMA_VERSION\b/);
    expect(generationSource).toMatch(/(?:^|\n)const\s+PROCESS_GENERATION_SCHEMA_VERSION\s*=\s*1;/);
    expect(generationSource).toMatch(/schema_version:\s*PROCESS_GENERATION_SCHEMA_VERSION/);
    expect(generationSource).toMatch(
      /p\.schema_version\s*===\s*PROCESS_GENERATION_SCHEMA_VERSION/,
    );
    expect(barrelSource).not.toMatch(/\bPROCESS_GENERATION_SCHEMA_VERSION\b/);
  });
});
