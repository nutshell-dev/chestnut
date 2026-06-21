import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 660: invariant that every depcruise forbidden rule's `comment`
 * field is at least 30 characters long.
 *
 * Rationale: comment is the SoT for the explanation users see at lint
 * failure. A trivial comment like `'forbidden'` or `'no'` leaves the
 * user knowing only the rule fired, not why or how to fix.
 *
 * Loose floor (30 chars) — current shortest is 108 chars; this catches
 * accidental copy-paste-trim that drops most of the comment, without
 * dictating long-form prose.
 *
 * phase 509 covers comment presence (non-null), phase 582 covers phase
 * NNN reference, phase 635 covers comment uniqueness. This phase adds
 * minimum-length guard (complementary).
 */
describe('depcruise rule comment length invariant (phase 660)', () => {
  it('every rule.comment.length ≥ 30', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(cfgPath) as {
      forbidden: Array<{ name: string; comment?: string }>;
    };
    const offenders = cfg.forbidden
      .filter(r => (r.comment?.length ?? 0) < 30)
      .map(r => `${r.name} (len=${r.comment?.length ?? 0})`);
    expect(offenders).toEqual([]);
  });
});
