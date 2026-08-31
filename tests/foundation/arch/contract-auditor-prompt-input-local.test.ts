import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const promptSource = readFileSync(
  new URL('../../../src/core/contract/auditor-prompt.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract AuditorPromptInput deep surface', () => {
  it('keeps the auditor prompt input type local behind buildAuditorPrompt', () => {
    expect(promptSource).not.toMatch(/export\s+interface\s+AuditorPromptInput\b/);
    expect(promptSource).toMatch(
      /(?:^|\n)interface\s+AuditorPromptInput\s*\{[\s\S]*?contractId:\s*string;[\s\S]*?footprint:\s*ContractFootprint;/,
    );
    expect(promptSource).toMatch(
      /export\s+function\s+buildAuditorPrompt\(input:\s*AuditorPromptInput\):\s*string/,
    );
    expect(barrelSource).not.toMatch(/\bAuditorPromptInput\b/);
  });
});
