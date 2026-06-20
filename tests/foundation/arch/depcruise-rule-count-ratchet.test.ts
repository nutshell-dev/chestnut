import { describe, it, expect } from 'vitest';
import config from '../../../.config/dependency-cruiser.cjs';

/**
 * phase 494: ratchet test for dependency-cruiser forbidden rule count.
 *
 * 当前 (main HEAD d3d8ff51 phase 444) 含 19 条 forbidden rules：
 *   - no-core-to-assembly + no-foundation-to-core + no-subagent-to-runtime (M#5)
 *   - fs-only-via-foundation-filesystem (M#3)
 *   - no-orphans (warn)
 *   - nodefilesystem-only-from-bootstrap (M#7)
 *   - 11 条 no-deep-into-* (barrel-only)
 *   - no-circular (M#5)
 *
 * 此 ratchet 防 future 误删 rules、要求 count ≥ 19。新增 rule 时调高下限。
 */
describe('dependency-cruiser rule count ratchet (phase 494)', () => {
  it('forbidden rules count ≥ 19 (current baseline)', () => {
    expect(config.forbidden.length).toBeGreaterThanOrEqual(19);
  });
});
