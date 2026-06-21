import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 604: invariant that every entry in `meta.messages` of every
 * chestnut-custom ESLint rule is a non-empty trimmed string.
 *
 * Rationale: meta.messages is the SoT for ESLint report text — context.report
 * lookups consume this map by messageId. Empty / undefined / non-string entry
 * → developer sees the rule fire but no explanatory text → black-box
 * punisher (same shape as phase 603 description failure mode, different
 * surfacing channel).
 *
 * Extends phase 597 (meta.messages presence) with content-level non-empty
 * constraint. Pairs with phase 603 (description non-empty), phase 598
 * (应然 marker), phase 596 (meta.type='problem').
 */
describe('ESLint chestnut-custom rule messages non-empty invariant (phase 604)', () => {
  it('every meta.messages value is non-empty string', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { messages?: Record<string, unknown> } };
      };
      const messages = mod?.default?.meta?.messages ?? {};
      for (const [k, v] of Object.entries(messages)) {
        if (typeof v !== 'string' || v.trim().length === 0) {
          offenders.push(`${f}:${k}=${String(v)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
