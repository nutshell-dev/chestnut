import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const literalReplaceSource = readFileSync(
  new URL('../../../src/foundation/file-tool/literal-replace.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool LiteralReplaceResult deep surface', () => {
  it('keeps the result type local behind literalReplace', () => {
    expect(literalReplaceSource).not.toMatch(/export\s+type\s+LiteralReplaceResult\b/);
    expect(literalReplaceSource).toMatch(
      /(?:^|\n)type\s+LiteralReplaceResult\s*=\s*\|\s*\{\s*ok:\s*true;\s*content:\s*string;\s*matches:\s*number;\s*replaced:\s*number;\s*firstIndex:\s*number;\s*\}\s*\|\s*\{\s*ok:\s*false;\s*reason:\s*'not-found'\s*\|\s*'multiple-matches';\s*matches:\s*number;\s*\};/,
    );
    expect(literalReplaceSource).toMatch(/\):\s*LiteralReplaceResult\s*\{/);
    expect(barrelSource).not.toMatch(/\bLiteralReplaceResult\b/);
  });
});
