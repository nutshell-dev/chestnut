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
 * Doesn't lock specific values — only that all projects agree. Project
 * may upgrade these by editing all projects in one commit.
 *
 * Pairs with phase 611 (vitest exclude base patterns), phase 610
 * (projects name unique), phase 634 (coverage config baseline).
 */
type Proj = { test?: { pool?: unknown; testTimeout?: unknown; hookTimeout?: unknown } };

describe('vitest projects pool + timeout consistency invariant (phase 654)', () => {
  it('all projects share same pool + testTimeout + hookTimeout', async () => {
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
    const testTimeouts = new Set(projects.map(p => p.test?.testTimeout));
    const hookTimeouts = new Set(projects.map(p => p.test?.hookTimeout));

    expect(pools.size).toBe(1);
    expect(testTimeouts.size).toBe(1);
    expect(hookTimeouts.size).toBe(1);
  });
});
