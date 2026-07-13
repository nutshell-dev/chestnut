import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 615: invariant that .config/dependency-cruiser.cjs options has the
 * baseline configuration:
 * - options.tsConfig.fileName === 'tsconfig.json'
 * - options.doNotFollow.path === 'node_modules'
 * - options.exclude.path === '^(tests|scripts|dist|node_modules)'
 *
 * Rationale:
 * - tsConfig.fileName drift → depcruise loses path-alias resolution → all
 *   TS path resolution breaks, every rule becomes false positive.
 * - doNotFollow drift → depcruise descends into node_modules → scan
 *   wall-time explodes + false positives from dep internals.
 * - exclude drift → tests / scripts / dist get scanned → meaningless
 *   violations spam (test code intentionally violates rules for fixtures).
 *
 * Pairs with phase 1301 (tsPreCompilationDeps invariant), phase 595
 * (forbidden rule from.path), phase 599 (forbidden rule to/orphan).
 */
describe('depcruise options baseline invariant (phase 615)', () => {
  it('tsConfig.fileName + doNotFollow.path + exclude.path match baseline', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    const cfg = require(cfgPath) as {
      options?: {
        tsConfig?: { fileName?: string };
        doNotFollow?: { path?: string };
        exclude?: { path?: string };
      };
    };
    const opts = cfg.options ?? {};
    expect(opts.tsConfig?.fileName).toBe('tsconfig.json');
    expect(opts.doNotFollow?.path).toBe('node_modules');
    expect(opts.exclude?.path).toBe('^(tests|scripts|dist|node_modules)');
  });
});
