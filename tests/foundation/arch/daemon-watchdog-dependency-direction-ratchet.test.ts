import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 1247 Step E ratchet: Daemon must have zero production imports from Watchdog.
 *
 * Design goal: CLI owns supervision; Watchdog owns generation terminal evidence.
 * Daemon no longer observes Watchdog (Step D removed the watchdogAliveProbe and
 * WATCHDOG_MISSING event). This test fails if any src/daemon/** production module
 * reintroduces a static dependency on src/watchdog/**.
 */
describe('Daemon→Watchdog dependency direction ratchet (phase 1247)', () => {
  const projectRoot = path.join(__dirname, '..', '..', '..');
  const daemonDir = path.join(projectRoot, 'src', 'daemon');
  const fixturesDir = path.join(__dirname, 'fixtures');

  function scanForWatchdogImports(dir: string): string[] {
    const matches: string[] = [];
    function walk(current: string) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf-8');
          if (/from\s+['"][^'"]*watchdog\//.test(content)) {
            matches.push(path.relative(projectRoot, full));
          }
        }
      }
    }
    walk(dir);
    return matches;
  }

  it('src/daemon has no imports from watchdog modules', () => {
    expect(scanForWatchdogImports(daemonDir)).toEqual([]);
  });

  it('scanner detects Daemon violation fixture', () => {
    expect(scanForWatchdogImports(fixturesDir)).toContain(
      'tests/foundation/arch/fixtures/daemon-watchdog-import-violation.ts',
    );
  });
});
