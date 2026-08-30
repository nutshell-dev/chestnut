import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editCommitSource = readFileSync(
  new URL('../../../src/foundation/file-tool/edit-commit.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/file-tool/index.ts', import.meta.url),
  'utf8',
);

describe('FileTool EditCommitTool deep surface', () => {
  it('keeps the edit commit tool type local behind EditCommitInput', () => {
    expect(editCommitSource).not.toMatch(/export\s+type\s+EditCommitTool\b/);
    expect(editCommitSource).toMatch(
      /(?:^|\n)type\s+EditCommitTool\s*=\s*'edit'\s*\|\s*'multi_edit';/,
    );
    expect(editCommitSource).toMatch(/(?:^|\n)\s*tool:\s*EditCommitTool;/);
    expect(barrelSource).not.toMatch(/\bEditCommitTool\b/);
  });
});
