import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 655: invariant that vitest's top-level + every project has
 * `globals: true` AND `environment: 'node'`.
 *
 * Rationale (ML#3 single-source test environment): cross-project must
 * agree on test environment.
 * - globals=false somewhere → that project's tests need explicit `import
 *   { describe, it, expect } from 'vitest'`; suddenly fails loud
 * - environment=jsdom somewhere → DOM globals injected; can affect
 *   behavior of code that branches on `typeof window`
 *
 * Pairs with phase 654 (pool + timeouts consistent), phase 611 (exclude
 * base patterns), phase 610 (project names).
 */
type Tcfg = { globals?: unknown; environment?: unknown };
type Proj = { test?: Tcfg };

describe('vitest globals + environment invariant (phase 655)', () => {
  it('top-level + every project: globals=true + environment=node', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    if (!raw || typeof raw !== 'object') {
      throw new Error('vitest config default export not an object');
    }
    const cfg = raw as { test?: Tcfg & { projects?: Proj[] } };
    const top = cfg.test ?? {};
    const projects = top.projects ?? [];

    const surfaces: Array<{ label: string; cfg: Tcfg }> = [
      { label: 'top-level', cfg: top },
      ...projects.map((p, i) => ({
        label: `project[${i}]`,
        cfg: p.test ?? {},
      })),
    ];

    const offenders: string[] = [];
    for (const { label, cfg } of surfaces) {
      if (cfg.globals !== true) {
        offenders.push(`${label}: globals=${String(cfg.globals)}`);
      }
      if (cfg.environment !== 'node') {
        offenders.push(`${label}: environment=${String(cfg.environment)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
