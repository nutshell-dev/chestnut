import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const listArchiveSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/list-archive.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/index.ts', import.meta.url),
  'utf8',
);

describe('DialogStore ArchiveDialogRef deep surface', () => {
  it('keeps the archive dialog ref local behind listArchiveDialogFiles', () => {
    expect(listArchiveSource).not.toMatch(/export\s+interface\s+ArchiveDialogRef\s*\{/);
    expect(listArchiveSource).toMatch(
      /(?:^|\n)interface\s+ArchiveDialogRef\s*\{[\s\S]*?name:\s*string;[\s\S]*?relPath:\s*string;[\s\S]*?mtime:\s*number;[\s\S]*?\}/,
    );
    expect(listArchiveSource).toMatch(/\):\s*Promise<ArchiveDialogRef\[\]>\s*\{/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\blistArchiveDialogFiles\b[^}]*\}\s*from\s*'\.\/list-archive\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bArchiveDialogRef\b/);
  });
});
