import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editSource = readFileSync(
  new URL('../../../src/foundation/file-tool/edit.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool EDIT_TOOL_NAME deep surface', () => {
  it('keeps the edit tool name const local behind editTool', () => {
    expect(editSource).not.toMatch(/export\s+const\s+EDIT_TOOL_NAME\b/);
    expect(editSource).toMatch(/(?:^|\n)const\s+EDIT_TOOL_NAME\s*=\s*'edit' as const;/);
    expect(editSource).toMatch(/\n\s*name:\s*EDIT_TOOL_NAME,/);
    expect(barrelSource).not.toMatch(/\bEDIT_TOOL_NAME\b/);
  });
});
