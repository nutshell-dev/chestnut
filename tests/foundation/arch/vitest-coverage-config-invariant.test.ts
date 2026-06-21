import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 634: invariant that vitest config's `test.coverage` is at baseline:
 * - `provider: 'v8'`               — V8 native coverage API
 * - `reporter` includes `'lcov'`   — CI / codecov integration consumes
 * - `exclude` contains `'tests/'`, `'dist/'`, `'node_modules/'` — count
 *   only src code in metrics
 *
 * Rationale (ML#3 single-source metric reporting):
 * - provider drift to istanbul → ~10x slower, V8 API features unavailable
 * - reporter drift drops lcov → CI codecov integration can't consume
 * - exclude drift drops tests/ → metrics inflated by test code coverage
 * - exclude drift drops dist/ → build output skews metric meaning
 *
 * Doesn't lock the full reporter / exclude arrays — only the baselines.
 * Project may add reporters / exclusions without changing this invariant.
 *
 * Pairs with phase 611 (vitest exclude base), phase 610 (project names),
 * phase 609 (setupFiles).
 */
describe('vitest coverage config baseline invariant (phase 634)', () => {
  it('provider=v8 + reporter has lcov + exclude has tests/dist/node_modules', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    if (!raw || typeof raw !== 'object') {
      throw new Error('vitest config default export not an object');
    }
    const cfg = raw as {
      test?: {
        coverage?: {
          provider?: string;
          reporter?: string[];
          exclude?: string[];
        };
      };
    };
    const cov = cfg.test?.coverage ?? {};
    expect(cov.provider).toBe('v8');
    expect(cov.reporter ?? []).toContain('lcov');
    const REQUIRED_EXCLUDE = ['tests/', 'dist/', 'node_modules/'];
    const missing = REQUIRED_EXCLUDE.filter(p => !(cov.exclude ?? []).includes(p));
    expect(missing).toEqual([]);
  });
});
