import { describe, it, expect } from 'vitest';
import config from '../../../.config/dependency-cruiser.cjs';

/**
 * phase 509: invariant that every forbidden rule has severity ∈ {error, warn}.
 *
 * Prevents accidental severity downgrade to info / off / undefined
 * which would silently disable enforcement.
 */
describe('forbidden rule severity invariant (phase 509)', () => {
  it('every forbidden rule has severity error or warn', () => {
    const allowed = new Set(['error', 'warn']);
    const bad = (config.forbidden as { name: string; severity: string }[])
      .filter(r => !allowed.has(r.severity))
      .map(r => `${r.name} (severity=${r.severity})`);
    expect(bad).toEqual([]);
  });

  it('every forbidden rule has a name and a comment', () => {
    const malformed = (config.forbidden as { name: string; comment?: string }[])
      .filter(r => !r.name || !r.comment)
      .map(r => r.name ?? '(unnamed)');
    expect(malformed).toEqual([]);
  });
});
