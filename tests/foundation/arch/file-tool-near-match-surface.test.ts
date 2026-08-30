import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editTextUtilsSource = readFileSync(
  new URL('../../../src/foundation/file-tool/edit-text-utils.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool NearMatch deep surface', () => {
  it('keeps the near match interface local behind findNearMatches', () => {
    expect(editTextUtilsSource).not.toMatch(/export\s+interface\s+NearMatch\s*\{/);
    expect(editTextUtilsSource).toMatch(
      /(?:^|\n)interface\s+NearMatch\s*\{[\s\S]*?\bline:\s*number;[\s\S]*?\btext:\s*string;[\s\S]*?\bscore:\s*'exact-prefix'\s*\|\s*'whitespace-diff'\s*\|\s*'partial-substring';[\s\S]*?\}/,
    );
    expect(editTextUtilsSource).toMatch(/\):\s*NearMatch\[\]\s*\{/);
    expect(editTextUtilsSource).toMatch(/const\s+matches:\s*NearMatch\[\]\s*=\s*\[\]/);
    expect(barrelSource).not.toMatch(/\bNearMatch\b/);
  });
});
