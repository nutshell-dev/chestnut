import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const barrel = readFileSync(
  new URL('../../../src/foundation/file-watcher/index.ts', import.meta.url),
  'utf8',
);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') ? [path] : [];
  });

const deepImportRe = /import[^;]*from\s+['"][^'"]*\/foundation\/file-watcher\/(?:types|watcher)\.js['"]/g;

describe('FileWatcher public contract surface', () => {
  it('exports public contract types through the owner barrel', () => {
    for (const name of ['Watcher', 'WatcherFactory', 'WatchEvent', 'WatcherErrorContext']) {
      expect(barrel).toMatch(
        new RegExp(`export\\s+type\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\./types\\.js['"]`, 's'),
      );
    }
  });

  it('has no deep FileWatcher imports in tests except the allowlisted fallback constant', () => {
    const offenders: string[] = [];
    for (const file of walk(join(repoRoot, 'tests'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(deepImportRe)) {
        const statement = match[0];
        if (
          file.endsWith('tests/foundation/file-watcher/fallback-escalation.test.ts') &&
          /\bFALLBACK_CONSECUTIVE_FAIL_LIMIT\b/.test(statement) &&
          /watcher\.js/.test(statement)
        ) {
          continue;
        }
        offenders.push(`${file}: ${statement.replace(/\s+/g, ' ').trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
