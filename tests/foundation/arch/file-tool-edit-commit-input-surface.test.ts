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

describe('FileTool EditCommitInput deep surface', () => {
  it('keeps the input interface local behind editCommit', () => {
    expect(editCommitSource).not.toMatch(/export\s+interface\s+EditCommitInput\s*\{/);
    expect(editCommitSource).toMatch(
      /(?:^|\n)interface\s+EditCommitInput\s*\{\s*\bctx:\s*ExecContext;\s*\btool:\s*EditCommitTool;\s*\bpath:\s*string;\s*\bresolved:\s*string;\s*\boriginal:\s*string;\s*\bcandidate:\s*string;\s*\bbackupSource:\s*EditCommitBackupSource;\s*\breplaced:\s*number;\s*\beditCount:\s*number;\s*\}/,
    );
    expect(editCommitSource).toMatch(/(?:^|\n)\s*input:\s*EditCommitInput,/);
    expect(barrelSource).not.toMatch(/\bEditCommitInput\b/);
  });
});
