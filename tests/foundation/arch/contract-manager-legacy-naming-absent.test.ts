import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/manager.ts', import.meta.url), 'utf8');
describe('manager legacy naming absence (Phase 1899 Step C)', () => {
  it('does not call the sole active-path methods legacy', () => {
    expect(source).not.toMatch(/_getLegacyActiveProgress/);
    expect(source).not.toMatch(/transitionLegacyVerificationAttempt/);
  });
});
