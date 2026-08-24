import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const barrel = readFileSync(
  new URL('../../../src/foundation/file-watcher/index.ts', import.meta.url),
  'utf8',
);
const watcherSource = readFileSync(
  new URL('../../../src/foundation/file-watcher/watcher.ts', import.meta.url),
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

  it('keeps the fallback failure limit local and fixed at five', () => {
    expect(watcherSource).not.toMatch(/export\s+const\s+FALLBACK_CONSECUTIVE_FAIL_LIMIT\b/);
    expect(watcherSource).toMatch(/const\s+FALLBACK_CONSECUTIVE_FAIL_LIMIT\s*=\s*5;/);
    expect(watcherSource).toMatch(/consecutiveCallbackFails\s*>=\s*FALLBACK_CONSECUTIVE_FAIL_LIMIT/);
  });

  it('keeps stable-mode timing parameters local and wired to awaitWriteFinish', () => {
    expect(watcherSource).not.toMatch(/export\s+const\s+CHOKIDAR_STABILITY_THRESHOLD_MS\b/);
    expect(watcherSource).not.toMatch(/export\s+const\s+CHOKIDAR_POLL_INTERVAL_MS\b/);
    expect(watcherSource).toMatch(/const\s+CHOKIDAR_STABILITY_THRESHOLD_MS\s*=\s*100;/);
    expect(watcherSource).toMatch(/const\s+CHOKIDAR_POLL_INTERVAL_MS\s*=\s*50;/);
    expect(watcherSource).toMatch(/stabilityThreshold:\s*CHOKIDAR_STABILITY_THRESHOLD_MS/);
    expect(watcherSource).toMatch(/pollInterval:\s*CHOKIDAR_POLL_INTERVAL_MS/);
  });

  it('has no deep FileWatcher imports in tests', () => {
    const offenders: string[] = [];
    for (const file of walk(join(repoRoot, 'tests'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(deepImportRe)) {
        const statement = match[0];
        offenders.push(`${file}: ${statement.replace(/\s+/g, ' ').trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
