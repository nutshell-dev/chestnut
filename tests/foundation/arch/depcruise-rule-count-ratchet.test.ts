import { describe, it, expect } from 'vitest';
import config from '../../../.config/dependency-cruiser.cjs';

/**
 * phase 494: ratchet test for dependency-cruiser forbidden rule count.
 *
 * 起步 baseline 19 条 (phase 444)，累计加：
 *   - phase 455: crypto-only-from-foundation
 *   - phase 456: no-daemon-to-watchdog + no-watchdog-to-daemon
 *   - phase 457-489: 多条 no-deep-into-* barrel-only rules
 *   - phase 490: child-process-only-from-foundation-process-exec
 *   - phase 491: net-only-from-foundation-transport
 *   - phase 511: no-unused-node-modules
 *   - phase 520: no-root-constants-readd
 *   - phase 540/541: no-assembly-to-cli-shared-formatter
 *
 * phase 563 tighten baseline 19 → 50 (current 54)、留 4 buffer 防偶发临时去除。
 * 此 ratchet 防 future 误删 rules、要求 count ≥ 50。新增 rule 时持续调高下限。
 */
describe('dependency-cruiser rule count ratchet (phase 494 / phase 563 tightened)', () => {
  it('forbidden rules count ≥ 50 (phase 563 tightened baseline)', () => {
    expect(config.forbidden.length).toBeGreaterThanOrEqual(50);
  });
});
