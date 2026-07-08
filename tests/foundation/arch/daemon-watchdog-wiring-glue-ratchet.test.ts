import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 500: ratchet test baseline for daemon ↔ watchdog cross-module importers.
 *
 * Strict daemon/* → watchdog/* and watchdog/* → daemon/* is enforced by:
 *   - phase 456 lint rules (no-daemon-to-watchdog + no-watchdog-to-daemon)
 *   - phase 493 ratchet test
 *
 * This test snapshots the wiring glue importers (CLI / assembly / wiring entries)
 * that legitimately deep-import the watchdog or daemon module.
 *
 * Adding new importers requires explicit acknowledgement by updating the baseline.
 */
describe('daemon-watchdog cross-module baseline ratchet (phase 500)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

  function importerSet(grepPattern: string): Set<string> {
    const cmd = `grep -rEln "${grepPattern}" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    return new Set(
      out.trim().split('\n').filter(Boolean).map(f => path.relative(srcRoot, f)),
    );
  }

  it('watchdog deep importers from outside watchdog/ + daemon/ match baseline', () => {
    const all = importerSet(`from ['\\"][^'\\"]*watchdog/`);
    const fromOutside = [...all].filter(
      f => !f.startsWith('watchdog/') && !f.startsWith('daemon/'),
    ).sort();

    // baseline captured 2026-06-20 (main HEAD d3d8ff51 + phase 444 已合)
    // phase 552 update: 2 guidance composers (claw-inactivity / claw-crashed) 已迁 type import
    // 到 foundation/utils/claw-failure-classes、不再 import from watchdog/watchdog-utils。
    // phase 708 update: claw-failure-classes 迁 watchdog/、2 guidance composers 恢复 type-only import from watchdog。
    const expected = [
      'assembly/business-systems.ts',
      'assembly/config/compose-config.ts',
      'assembly/file-routing-aggregator.ts',
      'assembly/guidance/composers/claw-inactivity.ts',
      'assembly/guidance/composers/claw-crashed.ts',
      'cli/commands/claw-watch.ts',
      'cli/commands/init.ts',
      'cli/commands/status.ts',
      'cli/commands/stop.ts',
      'cli/index.ts',
      'daemon-entry.ts',
      'watchdog-entry.ts',
    ].sort();
    expect(fromOutside).toEqual(expected);
  });
});
