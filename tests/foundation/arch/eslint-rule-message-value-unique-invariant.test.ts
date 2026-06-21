import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 637: invariant that every chestnut-custom rule's
 * `meta.messages` *value* (the report text) is unique across all rules.
 *
 * Rationale (ML#3 single-source error text): each message value is the
 * SoT for ESLint report text. Drift breaks invisibly when copy-paste
 * leaves two rules sharing a value:
 * - developer sees "rule X: <text>" in lint output, but X may have been
 *   triggered by either rule's logic — debugging path becomes guesswork
 * - subtle bugs hide: if rule A is broken but rule B fires the same
 *   text, no observable signal that A was supposed to catch something
 *
 * Pairs with phase 604 (messages non-empty), phase 617 (messageId
 * camelCase), phase 607 (messageId set-equivalence), phase 636
 * (description uniqueness).
 */
describe('ESLint rule message value uniqueness invariant (phase 637)', () => {
  it('every meta.messages value is unique across all rules', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { messages?: Record<string, string> } };
      };
      const messages = mod?.default?.meta?.messages ?? {};
      for (const [k, v] of Object.entries(messages)) {
        const ref = `${f}:${k}`;
        if (seen.has(v)) {
          duplicates.push(`${ref} ↔ ${seen.get(v)} (shared: ${v.slice(0, 60)}…)`);
        } else {
          seen.set(v, ref);
        }
      }
    }
    expect(duplicates).toEqual([]);
  });
});
