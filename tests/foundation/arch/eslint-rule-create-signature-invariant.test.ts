import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 680: invariant that every chestnut-custom rule .js source has
 * `create(context)` as a regular method (not arrow function) and
 * returns a visitor object via `return {`.
 *
 * Rationale (ML#3 single-source signature): ESLint rule create signature
 * is the call contract. chestnut-custom standardizes regular method
 * `create(context) { ... }` with parameter `context`. Drift to:
 * - arrow `create: (context) =>` → ESLint semantics same (this binding
 *   irrelevant) but style fragments
 * - parameter rename `ctx` / `_context` → grep / refactor drift
 *
 * Pairs with phase 597 (structural quartet — create present), phase
 * 596 (meta.type='problem'), phase 665 (meta keys strict), phase 666
 * (export keys strict).
 */
describe('ESLint rule create signature invariant (phase 680)', () => {
  it('every rule has create(context) regular method + return {', () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const createRe = /\bcreate\s*\(\s*context\s*\)/;
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(rulesDir, f), 'utf-8');
      if (!createRe.test(text)) offenders.push(`${f}: no create(context)`);
      if (!text.includes('return {')) offenders.push(`${f}: no return {`);
    }
    expect(offenders).toEqual([]);
  });
});
