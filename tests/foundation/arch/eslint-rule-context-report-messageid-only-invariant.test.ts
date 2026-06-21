import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 668: invariant that every chestnut-custom rule uses
 * `context.report({ ..., messageId: '...' })` and NOT the legacy
 * `context.report({ message: '<inline>', ... })` pattern.
 *
 * Rationale (ML#9 explicit coupling):
 * - inline `message:` decouples report text from meta.messages SoT;
 *   phase 607 messageId set-equivalence invariant can't catch it
 * - i18n impossible (messageId is the i18n key)
 * - ESLint 8+ best-practice is messageId-only
 *
 * Pairs with phase 607 (messageId set-equivalence), phase 604 (messages
 * non-empty), phase 617 (messageId camelCase), phase 666 (export keys
 * strict), phase 597 (structural quartet).
 */
describe('ESLint rule context.report messageId-only invariant (phase 668)', () => {
  it('every rule uses context.report + no inline message:', () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const missingReport: string[] = [];
    const inlineMessage: string[] = [];
    // matches context.report({...message:...) — non-greedy with [\s\S] for
    // multi-line option objects.
    const inlineRe = /context\.report[\s\S]*?\bmessage:/;
    for (const f of files) {
      const text = fs.readFileSync(path.join(rulesDir, f), 'utf-8');
      if (!text.includes('context.report')) missingReport.push(f);
      if (inlineRe.test(text)) inlineMessage.push(f);
    }
    expect(missingReport).toEqual([]);
    expect(inlineMessage).toEqual([]);
  });
});
