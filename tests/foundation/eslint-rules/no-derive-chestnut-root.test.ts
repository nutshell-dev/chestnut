import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noDeriveChestnutRoot from '../../../.config/eslint-rules/no-derive-chestnut-root.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-derive-chestnut-root (phase 327)', () => {
  ruleTester.run('no-derive-chestnut-root', noDeriveChestnutRoot, {
    valid: [
      // correct helper
      'const root = getChestnutRoot();',
      'const root = makeChestnutRoot(getChestnutRoot());',
      // different identifier
      'const root = deriveOtherRoot();',
    ],
    invalid: [
      // identifier usage
      {
        code: 'const root = deriveChestnutRoot();',
        errors: [{ messageId: 'deriveHelper' }],
      },
      // function declaration
      {
        code: 'function deriveChestnutRoot() {}',
        errors: [{ messageId: 'deriveHelper' }],
      },
      // import (identifier in import specifier - hits imported + local binding, 2 errors)
      {
        code: 'import { deriveChestnutRoot } from "./helper.js";',
        errors: [{ messageId: 'deriveHelper' }, { messageId: 'deriveHelper' }],
      },
    ],
  });

});
