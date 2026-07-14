import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 654: invariant that all vitest projects share the same `pool`,
 * `testTimeout`, and `hookTimeout` values.
 *
 * Rationale (ML#3 single-source test-runner config): vitest projects are
 * a single test runner running multiple subsets. Their runtime params
 * (pool kind, timeout magnitudes) must agree, otherwise:
 * - one project times out at 5s but another at 15s → flaky tests cross
 *   project boundaries unpredictably
 * - one uses `pool: 'forks'` while another uses `'threads'` → memory
 *   isolation differs; same test can pass in one and fail in the other
 *
 * phase 1006 update: integration / infra projects need longer timeouts and
 * tighter concurrency, so the strict uniformity check applies only to the
 * unit projects (fast + isolated). All projects still use the same pool kind.
 *
 * Pairs with phase 611 (vitest exclude base patterns), phase 610
 * (projects name unique), phase 634 (coverage config baseline).
 */
type Proj = { test?: { name?: string; pool?: unknown; testTimeout?: unknown; hookTimeout?: unknown } };

const UNIT_PROJECT_NAMES = new Set(['fast', 'isolated']);

describe('vitest projects pool + timeout consistency invariant (phase 654)', () => {
  it('all projects share same pool; unit projects share same testTimeout + hookTimeout', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    if (!raw || typeof raw !== 'object') {
      throw new Error('vitest config default export not an object');
    }
    const cfg = raw as { test?: { projects?: Proj[] } };
    const projects = cfg.test?.projects ?? [];
    expect(projects.length).toBeGreaterThan(1);

    const pools = new Set(projects.map(p => p.test?.pool));
    expect(pools.size).toBe(1);

    const unitProjects = projects.filter(p => UNIT_PROJECT_NAMES.has(p.test?.name ?? ''));
    const unitTestTimeouts = new Set(unitProjects.map(p => p.test?.testTimeout));
    const unitHookTimeouts = new Set(unitProjects.map(p => p.test?.hookTimeout));
    expect(unitTestTimeouts.size).toBe(1);
    expect(unitHookTimeouts.size).toBe(1);
  });
});
