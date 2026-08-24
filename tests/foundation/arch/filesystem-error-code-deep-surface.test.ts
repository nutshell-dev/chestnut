import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const typesSource = readFileSync(
  new URL('../../../src/foundation/fs/types.ts', import.meta.url),
  'utf8',
);

describe('FileSystem FSErrorCode deep surface', () => {
  it('keeps FSErrorCode local while preserving FileNotFoundError.code binding', () => {
    expect(typesSource).not.toMatch(/export\s+type\s+FSErrorCode\s*=/);
    expect(typesSource).toMatch(/(?:^|\n)type\s+FSErrorCode\s*=\s*'FS_NOT_FOUND';/);
    expect(typesSource).toMatch(/readonly\s+code:\s*FSErrorCode\s*=\s*'FS_NOT_FOUND';/);
  });
});
