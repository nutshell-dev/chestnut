import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = readFileSync(
  new URL('../../../src/foundation/file-tool/read.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool READ_TOOL_NAME deep surface', () => {
  it('keeps the read tool name const local behind readTool', () => {
    expect(readSource).not.toMatch(/export\s+const\s+READ_TOOL_NAME\b/);
    expect(readSource).toMatch(/(?:^|\n)const\s+READ_TOOL_NAME\s*=\s*'read' as const;/);
    expect(readSource).toMatch(/\n\s*name:\s*READ_TOOL_NAME,/);
    expect(barrelSource).not.toMatch(/\bREAD_TOOL_NAME\b/);
  });
});
