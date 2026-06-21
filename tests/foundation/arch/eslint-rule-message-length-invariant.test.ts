import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 662: invariant that every chestnut-custom rule's
 * `meta.messages` value is at least 30 characters long.
 *
 * Rationale: message value is the SoT for ESLint report text. Trivial
 * value like 'X' leaves user knowing rule fired but not why or how to
 * fix.
 *
 * Loose floor 30 chars — current shortest is 84 chars; catches
 * accidental clip without dictating long-form prose.
 *
 * Pairs with phase 604 (non-empty), phase 637 (unique), phase 617 (key
 * camelCase), phase 661 (description length).
 */
describe('ESLint rule message length invariant (phase 662)', () => {
  it('every meta.messages value length ≥ 30', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { messages?: Record<string, string> } };
      };
      const messages = mod?.default?.meta?.messages ?? {};
      for (const [k, v] of Object.entries(messages)) {
        if (v.length < 30) offenders.push(`${f}:${k} (len=${v.length})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
