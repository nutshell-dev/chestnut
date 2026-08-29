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

describe('ProcessManager CommitSpawning deep surface', () => {
  it('keeps the commit spawning outcome type local behind the public commitSpawning', () => {
    expect(generationSource).not.toMatch(/export\s+type\s+CommitSpawning\b/);
    expect(generationSource).toMatch(/(?:^|\n)type\s+CommitSpawning\s*=/);
    expect(generationSource).toMatch(/export\s+function\s+commitSpawning\(/);
    expect(generationSource).toMatch(/\):\s*CommitSpawning\s*\{/g);
    expect(barrelSource).not.toMatch(/\bCommitSpawning\b/);
  });
});
