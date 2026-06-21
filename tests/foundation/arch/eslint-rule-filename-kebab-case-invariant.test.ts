import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 648: invariant that every chestnut-custom ESLint rule filename
 * (basename without .js) matches kebab-case
 * `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`.
 *
 * Rationale: ESLint community convention (mirrored by upstream rules
 * like `no-unused-vars`, `no-empty-function`) standardizes rule names on
 * kebab-case. chestnut-custom follows this convention — drift to
 * camelCase / PascalCase / snake_case fragments grep, IDE autocomplete,
 * and creates ambiguity between rule key (plugin.rules['<name>']) and
 * rule file basename.
 *
 * Pairs with phase 580 (rule ↔ test 1:1), phase 591 (3-way pairing),
 * phase 617 (messageId camelCase), phase 606 (run name === basename).
 */
describe('ESLint custom rule filename kebab-case invariant (phase 648)', () => {
  it('every rule basename matches /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/', () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.js'));
    const kebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    const offenders: string[] = [];
    for (const f of files) {
      const basename = f.replace(/\.js$/, '');
      if (!kebab.test(basename)) offenders.push(basename);
    }
    expect(offenders).toEqual([]);
  });
});
