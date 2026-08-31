import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dirsSource = readFileSync(
  new URL('../../../src/core/contract/dirs.ts', import.meta.url),
  'utf8',
);

describe('Contract CONTRACT_ARCHIVE_CANCELLED_DIR dead surface', () => {
  it('has no CONTRACT_ARCHIVE_CANCELLED_DIR anywhere in the dirs source', () => {
    expect(dirsSource).not.toMatch(/\bCONTRACT_ARCHIVE_CANCELLED_DIR\b/);
  });

  it('keeps a stable live dir anchor intact', () => {
    expect(dirsSource).toMatch(/export\s+const\s+CONTRACT_ARCHIVE_DIR\s*=\s*'contract\/archive'\s+as\s+const;/);
  });
});
