import { describe, it, expect } from 'vitest';
import config from '../../../.config/dependency-cruiser.cjs';

/**
 * phase 579: invariant test that every forbidden rule name follows one of two
 * established conventions:
 *
 * 1. `no-<X>` prefix — forbid-direction / dead-pattern rules (49 条 baseline)
 *    e.g. no-core-to-assembly / no-circular / no-deep-into-*
 *
 * 2. `<resource>-only-from-<owner>` infix — resource唯一 owner rules (5 条 baseline)
 *    e.g. fs-only-via-foundation-filesystem / crypto-only-from-foundation /
 *         child-process-only-from-foundation-process-exec / net-only-from-foundation-transport
 *    (`fs-only-via-` 兼容 historical naming with `via` instead of `from`)
 *
 * Prevents naming-style drift when future rules are added.
 */
describe('forbidden rule naming convention invariant (phase 579)', () => {
  it('every forbidden rule name starts with "no-" or contains "-only-"', () => {
    const names = (config.forbidden as { name: string }[]).map(r => r.name);
    const violators = names.filter(n => !n.startsWith('no-') && !n.includes('-only-'));
    expect(violators).toEqual([]);
  });
});
