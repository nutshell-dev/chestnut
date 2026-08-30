import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const searchSource = readFileSync(
  new URL('../../../src/foundation/file-tool/search.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool SEARCH_TOOL_NAME deep surface', () => {
  it('keeps the search tool name const local behind searchTool', () => {
    expect(searchSource).not.toMatch(/export\s+const\s+SEARCH_TOOL_NAME\b/);
    expect(searchSource).toMatch(/(?:^|\n)const\s+SEARCH_TOOL_NAME\s*=\s*'search' as const;/);
    expect(searchSource).toMatch(/\n\s*name:\s*SEARCH_TOOL_NAME,/);
    expect(barrelSource).not.toMatch(/\bSEARCH_TOOL_NAME\b/);
  });
});
