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

describe('FileTool EditCommitResult deep surface', () => {
  it('keeps the result type local behind editCommit', () => {
    expect(editCommitSource).not.toMatch(/export\s+type\s+EditCommitResult\b/);
    expect(editCommitSource).toMatch(
      /(?:^|\n)type\s+EditCommitResult\s*=\s*\|\s*\{\s*ok:\s*true;\s*beforeHash:\s*string;\s*afterHash:\s*string;\s*backupPath:\s*string;\s*mtime:\s*number;\s*\}\s*\|\s*\{\s*ok:\s*false;\s*reason:\s*'conflict'\s*\|\s*'backup-failed'\s*\|\s*'verification-failed';\s*content:\s*string;\s*\};/,
    );
    expect(editCommitSource).toMatch(/\):\s*Promise<EditCommitResult>\s*\{/);
    expect(barrelSource).not.toMatch(/\bEditCommitResult\b/);
  });
});
