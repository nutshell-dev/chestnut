import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const creationSource = readFileSync(
  new URL('../../../src/core/contract/creation.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract ActivePublication deep surface', () => {
  it('keeps the active publication union local behind the classification helpers', () => {
    expect(creationSource).not.toMatch(/export\s+type\s+ActivePublication\b/);
    expect(creationSource).toMatch(
      /(?:^|\n)type\s+ActivePublication\s*=\s*\n\s*\|\s*\{\s*kind:\s*'unpublished';\s*reason:\s*'creating'\s*\}\s*\n\s*\|\s*\{\s*kind:\s*'published'\s*\};/,
    );
    expect(creationSource).toMatch(
      /export\s+function\s+isActivePublished\(pub:\s*ActivePublication\):\s*boolean/,
    );
    expect(barrelSource).not.toMatch(/\bActivePublication\b/);
  });
});
