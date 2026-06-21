import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 611: invariant that every test-level exclude array in
 * .config/vitest.config.ts (top-level + each project's test.exclude)
 * contains the 3 baseline patterns:
 *
 *   - `**\/.chestnut/**` — exclude clawspace copy tests (phase 22 hist:
 *     vitest collected `.chestnut/claws/<id>/clawspace/.../tests/**`,
 *     import failed by path depth diff, triggered hook timeout).
 *   - `**\/node_modules/**` — exclude dependency tests interference.
 *   - `**\/dist/**` — exclude build output re-testing.
 *
 * These are baseline excludes, not optional optimizations — drift breaks
 * fast-runner reliability.
 *
 * Pairs with phase 610 (project names), phase 609 (setupFiles paths),
 * phase 608 (tsconfig strict).
 */
describe('vitest exclude base patterns invariant (phase 611)', () => {
  it('every test-level exclude contains 3 base patterns', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    if (!raw || typeof raw !== 'object') {
      throw new Error('vitest config default export not an object');
    }
    const cfg = raw as {
      test?: {
        exclude?: string[];
        projects?: Array<{ test?: { exclude?: string[]; name?: string } }>;
      };
    };
    const REQUIRED = ['**/.chestnut/**', '**/node_modules/**', '**/dist/**'];
    const arrays: Array<{ label: string; arr: string[] }> = [];
    if (cfg.test?.exclude) arrays.push({ label: 'top-level', arr: cfg.test.exclude });
    for (const p of cfg.test?.projects ?? []) {
      const label = `project:${p.test?.name ?? 'unnamed'}`;
      const arr = p.test?.exclude ?? [];
      arrays.push({ label, arr });
    }

    expect(arrays.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const { label, arr } of arrays) {
      for (const pat of REQUIRED) {
        if (!arr.includes(pat)) offenders.push(`${label}: missing ${pat}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
