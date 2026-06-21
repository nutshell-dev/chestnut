import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 610: invariant that every vitest project in test.projects[] has a
 * non-empty `test.name` field and all names are unique.
 *
 * Rationale: vitest projects[].test.name is the project identifier in test
 * runner UI + failure reports. Failure modes:
 * - empty / missing name → 'unnamed' project hard to disambiguate in output
 * - duplicate name → later override earlier, or behavior version-dependent;
 *   debugging which project actually ran becomes guesswork
 *
 * Pairs with phase 609 (setupFiles path existence), phase 608 (tsconfig
 * strict), phase 600/602 (config SoT).
 */
describe('vitest projects name unique+non-empty invariant (phase 610)', () => {
  it('every project has non-empty test.name + all names unique', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    if (!raw || typeof raw !== 'object') {
      throw new Error('vitest config default export not an object');
    }
    const cfg = raw as {
      test?: { projects?: Array<{ test?: { name?: unknown } }> };
    };
    const projects = cfg.test?.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    const names: string[] = [];
    for (let i = 0; i < projects.length; i++) {
      const name = projects[i]?.test?.name;
      if (typeof name !== 'string' || name.trim().length === 0) {
        offenders.push(`projects[${i}]: name=${String(name)}`);
        continue;
      }
      names.push(name);
    }
    expect(offenders).toEqual([]);
    expect(names.length).toBe(new Set(names).size);
  });
});
