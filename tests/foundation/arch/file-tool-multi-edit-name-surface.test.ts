import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const multiEditSource = readFileSync(
  new URL('../../../src/foundation/file-tool/multi_edit.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool MULTI_EDIT_TOOL_NAME deep surface', () => {
  it('keeps the multi_edit tool name const local behind multiEditTool', () => {
    expect(multiEditSource).not.toMatch(/export\s+const\s+MULTI_EDIT_TOOL_NAME\b/);
    expect(multiEditSource).toMatch(/(?:^|\n)const\s+MULTI_EDIT_TOOL_NAME\s*=\s*'multi_edit' as const;/);
    expect(multiEditSource).toMatch(/\n\s*name:\s*MULTI_EDIT_TOOL_NAME,/);
    expect(barrelSource).not.toMatch(/\bMULTI_EDIT_TOOL_NAME\b/);
  });
});
