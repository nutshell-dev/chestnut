import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const WATCHDOG = path.join(SRC, 'watchdog');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}

describe('phase 1345: Watchdog single production barrel', () => {
  it('all production imports from outside Watchdog target index.js', () => {
    const violations: string[] = [];
    for (const file of walk(SRC).filter((f) => !f.startsWith(WATCHDOG + path.sep))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/from\s+['"]([^'"]*watchdog\/[^'"]+)['"]/g)) {
        if (!match[1].endsWith('watchdog/index.js')) {
          violations.push(`${path.relative(SRC, file)} -> ${match[1]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('public barrel does not expose implementation or test controls', () => {
    const barrel = fs.readFileSync(path.join(WATCHDOG, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/export\s+\*/);
    expect(barrel).not.toMatch(/_reset|_setWatchdog|acquireWatchdogOwnership|shutdownWatchdog/);
    expect(barrel).toContain('runWatchdogLoop');
    expect(barrel).toContain('ensureWatchdog');
    expect(barrel).toContain('createWatchdogConfigMigration');
  });

  it('watchdog.ts no longer re-exports internal modules', () => {
    const implementation = fs.readFileSync(path.join(WATCHDOG, 'watchdog.ts'), 'utf8');
    expect(implementation).not.toMatch(/export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+['"]\.\//);
  });
});
