import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(process.cwd(), 'src');
const PROCESS_EXEC = path.join(SRC, 'foundation', 'process-exec');
const LEGACY_TEST_ADAPTER = path.join(SRC, 'cli', 'commands', 'stop.ts');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
  });
}

describe('ProcessExec legacy boolean boundary (Phase 2146 B1/B2)', () => {
  it('keeps legacy probes out of production callers', () => {
    const offenders = sources(SRC).flatMap(file => {
      if (file.startsWith(PROCESS_EXEC) || file === LEGACY_TEST_ADAPTER) return [];
      const source = readFileSync(file, 'utf8');
      return /\bisAlive\s*\(|\bisPidArgvMatching\s*\(|\bgetProcessStartTime\s*\(|\bisWatchdogAlive\s*\(/.test(source)
        ? [path.relative(SRC, file)]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  it('does not re-export legacy probes from the production barrel', () => {
    const barrel = readFileSync(path.join(PROCESS_EXEC, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/export\s*\{[^}]*\bisAlive\b/);
    expect(barrel).not.toMatch(/export\s*\{[^}]*\bisPidArgvMatching\b/);
    expect(barrel).not.toMatch(/export\s*\{[^}]*\bgetProcessStartTime\b/);
    expect(barrel).toMatch(/export\s*\{\s*observePidArgv\s*\}/);
  });
});
