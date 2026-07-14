import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noStringAnchorChestnut from '../../../.config/eslint-rules/no-string-anchor-chestnut.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-string-anchor-chestnut (phase 327)', () => {
  ruleTester.run('no-string-anchor-chestnut', noStringAnchorChestnut, {
    valid: [
      // indexOf on non-.chestnut
      'parts.indexOf("foo");',
      'str.indexOf(".chestnut2");',
      // includes (not indexOf)
      'parts.includes(".chestnut");',
      // correct: env-based
      'const root = getChestnutRoot();',
    ],
    invalid: [
      {
        code: 'const idx = parts.indexOf(".chestnut");',
        errors: [{ messageId: 'stringAnchor' }],
      },
      {
        code: 'if (path.indexOf(".chestnut") > 0) {}',
        errors: [{ messageId: 'stringAnchor' }],
      },
    ],
  });

});
