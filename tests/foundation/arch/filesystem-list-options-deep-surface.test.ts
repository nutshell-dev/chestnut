import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const typesSource = readFileSync(
  new URL('../../../src/foundation/fs/types.ts', import.meta.url),
  'utf8',
);

describe('FileSystem ListOptions deep surface', () => {
  it('keeps one local option shape shared by async and sync list', () => {
    expect(typesSource).not.toMatch(/export\s+interface\s+ListOptions\b/);
    expect(typesSource).toMatch(
      /(?:^|\n)interface\s+ListOptions\s*\{\s*recursive\?:\s*boolean;\s*includeDirs\?:\s*boolean;\s*pattern\?:\s*string;\s*\}/,
    );
    expect(typesSource.match(/options\?:\s*ListOptions/g)).toHaveLength(2);
  });
});
