import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 607: invariant that every chestnut-custom ESLint rule's
 * `meta.messages` declared keys set equals the set of `messageId:` references
 * in the rule source.
 *
 * Rationale (ML#9 explicit coupling): meta.messages declarations + create
 * body context.report({ messageId }) references are an inescapable coupling.
 * Drift breaks invisibly:
 * - declared ⊃ referenced → dead message keys, missed when removing rule
 *   variant, accumulate as cruft.
 * - referenced ⊄ declared → typo or undeclared messageId; ESLint falls back
 *   to '' or undefined-key handling at runtime, masking the actual report.
 *
 * Pairs with phase 604 (messages non-empty), phase 597 (meta.messages
 * presence), phase 587 (RuleTester), phase 605 (valid/invalid non-empty).
 */
describe('ESLint rule messageId set-equivalence invariant (phase 607)', () => {
  it('every rule meta.messages keys === messageId references in source', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    const messageIdRe = /messageId:\s*['"]([^'"]+)['"]/g;
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const src = fs.readFileSync(rulePath, 'utf-8');
      const mod = (await import(rulePath)) as {
        default?: { meta?: { messages?: Record<string, unknown> } };
      };
      const declared = new Set(Object.keys(mod?.default?.meta?.messages ?? {}));
      const referenced = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = messageIdRe.exec(src)) !== null) referenced.add(m[1]);
      messageIdRe.lastIndex = 0;

      const unused = [...declared].filter(k => !referenced.has(k));
      const undeclared = [...referenced].filter(k => !declared.has(k));
      if (unused.length > 0)
        offenders.push(`${f}: unused declared messageId(s): ${unused.join(', ')}`);
      if (undeclared.length > 0)
        offenders.push(`${f}: undeclared referenced messageId(s): ${undeclared.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
