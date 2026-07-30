import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 1243 Step B ratchet: Assembly must have zero production imports from Daemon.
 *
 * Design goal: Daemon→Assembly lifecycle direction is preserved; Assembly does not
 * statically depend on Daemon modules. External declarations are passed as data
 * through AssemblyContributions by the lifecycle caller (daemon-entry).
 */
describe('Assembly→Daemon dependency direction ratchet (phase 1243)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

  function grepFrom(pattern: string, dir: string): string[] {
    const cmd = `grep -rEln "${pattern}" ${dir} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(f => path.relative(srcRoot, f));
  }

  it('src/assembly has no imports from daemon modules', () => {
    const assemblyDir = path.join(srcRoot, 'assembly');
    const matches = grepFrom("from ['\\\"][^'\\\"]*daemon/", assemblyDir);
    expect(matches).toEqual([]);
  });

  it('scanner still detects daemon imports elsewhere (fixture validity)', () => {
    // daemon-entry.ts legitimately imports from ./index.js (same module), not Assembly→Daemon.
    // We use a broader pattern to prove the grep is not trivially broken.
    const matches = grepFrom("from ['\\\"][^'\\\"]*daemon", srcRoot);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches).toContain('daemon/daemon-entry.ts');
  });
});
