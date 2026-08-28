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

describe('ProcessManager getCandidatesDir deep surface', () => {
  it('keeps the candidates directory helper local behind getCandidateDir', () => {
    expect(generationSource).not.toMatch(/export\s+function\s+getCandidatesDir\b/);
    expect(generationSource).toMatch(
      /(?:^|\n)function\s+getCandidatesDir\(daemonDir:\s*DaemonDir\):\s*string\s*\{[\s\S]*?return path\.join\(getProcessDir\(daemonDir\),\s*CANDIDATES_DIR_NAME\);/,
    );
    expect(generationSource).toMatch(
      /return path\.join\(getCandidatesDir\(daemonDir\),\s*generationId\)/,
    );
    expect(barrelSource).not.toMatch(/\bgetCandidatesDir\b/);
  });
});
