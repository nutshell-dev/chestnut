import { describe, it, expect } from 'vitest';
import config from '../../../.config/dependency-cruiser.cjs';

/**
 * phase 510: invariant that all forbidden rule names are unique.
 *
 * dependency-cruiser would silently override rules with the same name,
 * so duplicate names lead to unexpected behavior. This catches it.
 */
describe('forbidden rule names uniqueness (phase 510)', () => {
  it('all forbidden rule names are unique', () => {
    const names = (config.forbidden as { name: string }[]).map(r => r.name);
    const dupes: string[] = [];
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    expect(dupes).toEqual([]);
  });
});
