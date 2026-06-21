import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 609: invariant that vitest config's `test.setupFiles` +
 * `test.globalSetup` paths all exist on disk.
 *
 * Rationale (ML#9 explicit coupling): config-referenced files must actually
 * exist. Drift breaks invisibly:
 * - setupFiles missing → mocks / env-injection silently skipped, tests run
 *   without expected init → false-green
 * - globalSetup missing → build/dist precondition skipped, downstream
 *   smoke tests fail with confusing root cause
 *
 * vitest's behavior on missing setup paths varies by minor version — some
 * fail-loud, some silently skip. Pinning this invariant defensively.
 *
 * Pairs with phase 608 (tsconfig strict-family), phase 600 (test* SoT),
 * phase 602 (tool config SoT).
 */
describe('vitest.config setupFiles+globalSetup path existence invariant (phase 609)', () => {
  it('every setupFiles + globalSetup path resolves to an existing file', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    if (!raw || typeof raw !== 'object') {
      throw new Error('vitest config default export not an object');
    }
    const cfg = raw as {
      test?: {
        setupFiles?: string | string[];
        globalSetup?: string | string[];
      };
    };
    const testCfg = cfg.test ?? {};
    const toArr = (v: string | string[] | undefined): string[] =>
      v === undefined ? [] : Array.isArray(v) ? v : [v];

    const allPaths = [
      ...toArr(testCfg.setupFiles).map(p => ({ kind: 'setupFiles', p })),
      ...toArr(testCfg.globalSetup).map(p => ({ kind: 'globalSetup', p })),
    ];

    expect(allPaths.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const { kind, p } of allPaths) {
      const resolved = path.resolve(repoRoot, p);
      if (!fs.existsSync(resolved)) missing.push(`${kind}: ${p} (resolved=${resolved})`);
    }
    expect(missing).toEqual([]);
  });
});
