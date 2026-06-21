import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 635: invariant that every depcruise forbidden rule has a unique
 * `comment` field — no two rules share the same comment string.
 *
 * Rationale (ML#3 single-source semantics): each rule's comment is the
 * SoT for that rule's *meaning*. Drift breaks invisibly when copy-paste
 * leaves two rules sharing a comment:
 * - rule A fires but the comment narrates rule B's intent → developer
 *   misdiagnoses scope
 * - delete rule A but its comment was the working SoT for rule B → B's
 *   intent doc lost
 *
 * Pairs with phase 559 (forbidden rule name uniqueness), phase 582
 * (comment phase reference), phase 633 (severity=error default).
 */
describe('depcruise forbidden rule comment uniqueness invariant (phase 635)', () => {
  it('every forbidden rule has unique comment', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(cfgPath) as {
      forbidden: Array<{ name: string; comment?: string }>;
    };
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const r of cfg.forbidden) {
      const c = r.comment ?? '';
      if (seen.has(c)) {
        duplicates.push(`${r.name} ↔ ${seen.get(c)} (shared comment: ${c.slice(0, 60)}…)`);
      } else {
        seen.set(c, r.name);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
