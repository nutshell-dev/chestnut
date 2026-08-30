import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const storeSource = readFileSync(
  new URL('../../../src/foundation/config-store/store.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/config-store/index.ts', import.meta.url),
  'utf8',
);

describe('ConfigStore LoaderDeps deep surface', () => {
  it('keeps the filesystem factory dependency shape local behind YAML operations', () => {
    expect(storeSource).not.toMatch(/export\s+interface\s+LoaderDeps\s*\{/);
    expect(storeSource).toMatch(/(?:^|\n)interface\s+LoaderDeps\s*\{/);
    expect(storeSource).toMatch(
      /interface\s+LoaderDeps\s*\{[\s\S]*?fsFactory:\s*\(baseDir:\s*string\)\s*=>\s*FileSystem;[\s\S]*?\}/,
    );
    expect(storeSource).toMatch(
      /export\s+function\s+loadYamlConfig<[^>]+>\(\s*deps:\s*LoaderDeps,/,
    );
    expect(storeSource).toMatch(
      /export\s+function\s+writeYamlConfig\(\s*deps:\s*LoaderDeps,/,
    );
    expect(storeSource).toMatch(
      /export\s+function\s+patchYamlConfig\(\s*deps:\s*LoaderDeps,/,
    );
    expect(storeSource).toMatch(
      /export\s+function\s+configExists\(deps:\s*LoaderDeps,/,
    );
    expect(barrelSource).not.toMatch(/\bLoaderDeps\b/);
  });
});
