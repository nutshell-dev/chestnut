import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 641: invariant that ci.yml + code-quality.yml workflows share the
 * same trigger surface — both fire on `push.branches: [main]` AND
 * `pull_request.branches: [main]`.
 *
 * Rationale (ML#3 single-source CI symmetry): ci + code-quality are
 * sister workflows; they must cover the same set of events to avoid
 * asymmetric checks on the same PR. Drift breaks invisibly:
 * - add a branch to ci.yml push but forget code-quality → that branch
 *   gets type/test checks but not lint/arch
 * - drop pull_request from one → PRs against main get partial coverage
 *
 * release.yml has different semantics (tag push) and is intentionally
 * excluded.
 *
 * Pairs with phase 626 (pnpm version consistency), phase 627 (node
 * version vs engines), phase 623 (script ref).
 */
describe('CI workflow trigger symmetry invariant (phase 641)', () => {
  it('ci.yml + code-quality.yml both fire on push + pull_request to main', () => {
    const wfDir = path.resolve(__dirname, '../../../.github/workflows');
    const sisters = ['ci.yml', 'code-quality.yml'];

    const offenders: string[] = [];
    for (const f of sisters) {
      const p = path.join(wfDir, f);
      expect(fs.existsSync(p), `${f} missing`).toBe(true);
      const text = fs.readFileSync(p, 'utf-8');
      // crude but adequate string checks — YAML is line-based
      if (!/push:\s*\n\s*branches:\s*\[\s*main\s*\]/m.test(text)) {
        offenders.push(`${f}: missing push.branches: [main]`);
      }
      if (!/pull_request:\s*\n\s*branches:\s*\[\s*main\s*\]/m.test(text)) {
        offenders.push(`${f}: missing pull_request.branches: [main]`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
