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

describe('FileTool EditCommitBackupSource deep surface', () => {
  it('keeps the backup source type local behind EditCommitInput', () => {
    expect(editCommitSource).not.toMatch(/export\s+type\s+EditCommitBackupSource\b/);
    expect(editCommitSource).toMatch(
      /(?:^|\n)type\s+EditCommitBackupSource\s*=\s*'edit_backup'\s*\|\s*'multi_edit_backup';/,
    );
    expect(editCommitSource).toMatch(/(?:^|\n)\s*backupSource:\s*EditCommitBackupSource;/);
    expect(barrelSource).not.toMatch(/\bEditCommitBackupSource\b/);
  });
});
