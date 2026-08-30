import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const writeSource = readFileSync(
  new URL('../../../src/foundation/file-tool/write.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool WRITE_TOOL_NAME deep surface', () => {
  it('keeps the write tool name const local behind writeTool', () => {
    expect(writeSource).not.toMatch(/export\s+const\s+WRITE_TOOL_NAME\b/);
    expect(writeSource).toMatch(/(?:^|\n)const\s+WRITE_TOOL_NAME\s*=\s*'write' as const;/);
    expect(writeSource).toMatch(/\n\s*name:\s*WRITE_TOOL_NAME,/);
    expect(barrelSource).not.toMatch(/\bWRITE_TOOL_NAME\b/);
  });
});
