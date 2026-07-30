import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 1243 Step F ratchet: Assembly must have zero production imports from Daemon.
 *
 * Design goal: Daemon→Assembly lifecycle direction is preserved; Assembly does not
 * statically depend on Daemon modules. External declarations are passed as data
 * through AssemblyContributions by the lifecycle caller (daemon-entry).
 */
describe('Assembly→Daemon dependency direction ratchet (phase 1243)', () => {
  const projectRoot = path.join(__dirname, '..', '..', '..');
  const assemblyDir = path.join(projectRoot, 'src', 'assembly');
  const fixturesDir = path.join(__dirname, 'fixtures');

  function scanForDaemonImports(dir: string): string[] {
    const matches: string[] = [];
    function walk(current: string) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf-8');
          if (/from\s+['"][^'"]*daemon\//.test(content)) {
            matches.push(path.relative(projectRoot, full));
          }
        }
      }
    }
    walk(dir);
    return matches;
  }

  it('src/assembly has no imports from daemon modules', () => {
    expect(scanForDaemonImports(assemblyDir)).toEqual([]);
  });

  it('scanner detects Assembly violation fixture', () => {
    expect(scanForDaemonImports(fixturesDir)).toContain(
      'tests/foundation/arch/fixtures/assembly-daemon-import-violation.ts',
    );
  });
});
