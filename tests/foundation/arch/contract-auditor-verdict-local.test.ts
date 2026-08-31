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

describe('Contract AuditorVerdict deep surface', () => {
  it('keeps the auditor verdict type local behind parseVerdict', () => {
    expect(auditorSource).not.toMatch(/export\s+interface\s+AuditorVerdict\b/);
    expect(auditorSource).toMatch(
      /(?:^|\n)interface\s+AuditorVerdict\s*\{\s*\n\s*on_track:\s*boolean;\s*\n\s*drifts:\s*AuditorDrift\[\];\s*\n\s*next_focus_suggestion:\s*string;\s*\n\}/,
    );
    expect(auditorSource).toMatch(
      /export\s+function\s+parseVerdict\(rawText:\s*string\):\s*AuditorVerdict/,
    );
    expect(barrelSource).not.toMatch(/\bAuditorVerdict\b/);
  });
});
