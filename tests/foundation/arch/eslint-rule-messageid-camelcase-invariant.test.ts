import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 617: invariant that every chestnut-custom ESLint rule's
 * `meta.messages` keys use camelCase naming.
 *
 * Rationale: ESLint convention (mirrored by upstream rules like
 * no-unused-vars / unusedVar) standardizes messageId on camelCase. Mixing
 * kebab-case / snake_case / PascalCase fragments grep / IDE autocomplete
 * and creates ambiguity at `context.report({ messageId })` call sites.
 *
 * Pairs with phase 607 (messageId set equivalence), phase 604 (messages
 * non-empty), phase 603 (description non-empty), phase 597 (structural
 * quartet).
 */
describe('ESLint rule messageId camelCase invariant (phase 617)', () => {
  it('every meta.messages key matches camelCase /^[a-z][a-zA-Z0-9]*$/', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    const camelCase = /^[a-z][a-zA-Z0-9]*$/;
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { messages?: Record<string, unknown> } };
      };
      const messages = mod?.default?.meta?.messages ?? {};
      for (const k of Object.keys(messages)) {
        if (!camelCase.test(k)) offenders.push(`${f}: '${k}' not camelCase`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
