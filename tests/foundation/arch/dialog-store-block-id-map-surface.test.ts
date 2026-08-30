import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const blockIdIndexSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/block-id-index.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/index.ts', import.meta.url),
  'utf8',
);

describe('DialogStore BlockIdMap deep surface', () => {
  it('keeps the block id map local behind BlockIdIndex', () => {
    expect(blockIdIndexSource).not.toMatch(/export\s+interface\s+BlockIdMap\s*\{/);
    expect(blockIdIndexSource).toMatch(
      /(?:^|\n)interface\s+BlockIdMap\s*\{\s*\[shortId:\s*string\]:\s*string;[\s\S]*?\}/,
    );
    expect(blockIdIndexSource).toMatch(/const\s+map:\s*BlockIdMap\s*=\s*\{\}/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bBlockIdIndex\b[^}]*\}\s*from\s*'\.\/block-id-index\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bBlockIdMap\b/);
  });
});
