import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 650: invariant that every test file under tests/foundation/arch/
 * and tests/foundation/eslint-rules/ has a basename (without .test.ts) in
 * strict kebab-case `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`.
 *
 * Rationale (ML#3 single-source naming): test files mirror their src
 * surface (config rule files / depcruise rule names) which are themselves
 * kebab-case. Drift to camelCase / snake_case fragments grep, IDE
 * navigation, and breaks the basename-as-key pattern used by phase 580
 * rule ↔ test pairing.
 *
 * Extends phase 648 (ESLint rule filename kebab-case) + phase 649
 * (depcruise rule name kebab-case) to the test-file layer.
 */
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

describe('arch + eslint-rules test file kebab-case invariant (phase 650)', () => {
  it('every test file basename matches kebab-case', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const dirs = [
      'tests/foundation/arch',
      'tests/foundation/eslint-rules',
    ];
    const offenders: string[] = [];
    for (const d of dirs) {
      const dirPath = path.join(repoRoot, d);
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.test.ts'));
      for (const f of files) {
        const basename = f.replace(/\.test\.ts$/, '');
        if (!KEBAB.test(basename)) offenders.push(`${d}/${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
