import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 658: invariant that vitest projects encode their design intent
 * via poolOptions.threads.isolate:
 * - `fast` project   → isolate=false (shared module registry, high
 *                      throughput, tests must be mock-safe)
 * - `isolated` project → isolate=true (each test file isolated, prevents
 *                        cross-file mock contamination)
 *
 * Drift breaks invisibly:
 * - fast.isolate=true → 5x slow-down, no functional break
 * - isolated.isolate=false → cross-file mock contamination, tests start
 *   passing/failing depending on file ordering, ghost flakes
 *
 * Pairs with phase 655 (globals + environment), phase 654 (pool +
 * timeouts), phase 611 (exclude base patterns), phase 610 (project
 * names).
 */
type Proj = {
  test?: {
    name?: string;
    poolOptions?: { threads?: { isolate?: unknown } };
  };
};

describe('vitest fast/isolated isolate invariant (phase 658)', () => {
  it('fast.isolate=false + isolated.isolate=true', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    if (!raw || typeof raw !== 'object') {
      throw new Error('vitest config default export not an object');
    }
    const cfg = raw as { test?: { projects?: Proj[] } };
    const projects = cfg.test?.projects ?? [];

    const fast = projects.find(p => p.test?.name === 'fast');
    const isolated = projects.find(p => p.test?.name === 'isolated');

    expect(fast, "project named 'fast' missing").toBeDefined();
    expect(isolated, "project named 'isolated' missing").toBeDefined();

    expect((fast as Proj).test?.poolOptions?.threads?.isolate).toBe(false);
    expect((isolated as Proj).test?.poolOptions?.threads?.isolate).toBe(true);
  });
});
