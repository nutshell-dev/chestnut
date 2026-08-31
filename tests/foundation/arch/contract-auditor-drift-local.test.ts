import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditorSource = readFileSync(
  new URL('../../../src/core/contract/contract-auditor.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract AuditorDrift deep surface', () => {
  it('keeps the auditor drift type local behind the verdict composition', () => {
    expect(auditorSource).not.toMatch(/export\s+interface\s+AuditorDrift\b/);
    expect(auditorSource).toMatch(
      /(?:^|\n)interface\s+AuditorDrift\s*\{\s*\n\s*what:\s*string;\s*\n\s*evidence:\s*string;\s*\n\}/,
    );
    expect(auditorSource).toMatch(/\bdrifts:\s*AuditorDrift\[\]/);
    expect(barrelSource).not.toMatch(/\bAuditorDrift\b/);
  });
});
