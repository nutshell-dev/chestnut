import { describe, it, expect } from 'vitest';
import config from '../../../.config/dependency-cruiser.cjs';

describe('dependency-cruiser: no-circular rule (phase 1316 终升 error / cleanup roadmap 5/5 完成)', () => {
  it('no-circular rule present at error severity (phase 1316 终升 / 0 cycle 不容回归)', () => {
    const rule = config.forbidden.find(
      (r: { name: string }) => r.name === 'no-circular',
    );
    expect(rule).toBeDefined();
    // phase 1316 终升: severity 'error' (cleanup roadmap 5/5 完成 / 0 cycle / future drift fail-loud)
    expect(rule.severity).toBe('error');
    expect(rule.to.circular).toBe(true);
  });
});
