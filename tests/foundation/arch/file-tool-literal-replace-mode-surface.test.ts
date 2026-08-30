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

describe('FileTool LiteralReplaceMode deep surface', () => {
  it('keeps the replace mode type local behind literalReplace', () => {
    expect(literalReplaceSource).not.toMatch(/export\s+type\s+LiteralReplaceMode\b/);
    expect(literalReplaceSource).toMatch(
      /(?:^|\n)type\s+LiteralReplaceMode\s*=\s*'unique'\s*\|\s*'all';/,
    );
    expect(literalReplaceSource).toMatch(/(?:^|\n)\s*mode:\s*LiteralReplaceMode,/);
    expect(barrelSource).not.toMatch(/\bLiteralReplaceMode\b/);
  });
});
