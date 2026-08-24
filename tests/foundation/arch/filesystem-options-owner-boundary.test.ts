import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const typesSource = readFileSync(
  new URL('../../../src/foundation/fs/types.ts', import.meta.url),
  'utf8',
);
const nodeFsSource = readFileSync(
  new URL('../../../src/foundation/fs/node-fs.ts', import.meta.url),
  'utf8',
);

describe('FileSystemOptions implementation owner boundary', () => {
  it('keeps the named constructor option shape local to node-fs', () => {
    expect(typesSource).not.toMatch(/\bFileSystemOptions\b/);
    expect(nodeFsSource).not.toMatch(/export\s+interface\s+FileSystemOptions\b/);
    expect(nodeFsSource).toMatch(
      /(?:^|\n)interface\s+FileSystemOptions\s*\{[\s\S]*?baseDir:\s*string;[\s\S]*?\}/,
    );
    expect(nodeFsSource.match(/\bFileSystemOptions\b/g)).toHaveLength(3);
    expect(nodeFsSource).toMatch(/constructor\(\s*options:\s*FileSystemOptions,?\s*\)/);
    expect(nodeFsSource).toMatch(/private\s+readonly\s+options:\s*FileSystemOptions;/);
  });
});
