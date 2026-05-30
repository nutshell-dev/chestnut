/**
 * phase 1469 invariant: 每 sender type 必显式 register（NO_GUIDANCE 或 real composer）.
 *
 * 守 DP「未经显式设计决策不得丢弃或静默忽略」 + ML#9「显式表达」 — 漏 register
 * 不可视为「故意 P3」、必报 fail（区别于 phase 1414 formatter registry 的「未注册则
 * fallback 静默不报」），由本 invariant 强制业主装配期表态。
 *
 * 化解 ML#8（对外表面最小、不分 markNoGuidance 多 API）vs DP「不静默」真冲突 by sentinel:
 *   - 1 API: register
 *   - sentinel value: NO_GUIDANCE
 *   - invariant: 必 register（sentinel 或 real）/ 漏注 fail
 */

import { describe, it, expect } from 'vitest';
import {
  extractRegisteredTypes,
  extractSenderTypes,
  extendWithOutboxRouted,
} from './guidance-registry-coverage.test.js';

describe('phase 1469: explicit no-guidance invariant (every sender type must be registered)', () => {
  it('registered set === extended sender set (incl. outbox-routed) — no orphan registrations, no stale', () => {
    const sentExtended = [...extendWithOutboxRouted(new Set(extractSenderTypes().keys()))].sort();
    const registered = [...extractRegisteredTypes()].sort();
    expect(registered).toEqual(sentExtended);
  });
});
