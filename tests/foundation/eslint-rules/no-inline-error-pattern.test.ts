import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noInlineErrorPattern from '../../../.config/eslint-rules/no-inline-error-pattern.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
});

describe('eslint custom rule: no-inline-error-pattern (phase 309)', () => {
  ruleTester.run('no-inline-error-pattern', noInlineErrorPattern, {
    valid: [
      // canonical: use formatErr
      'import { formatErr } from "../node-utils/index.js"; const msg = formatErr(e);',
      // form 2/3 containing `:` / not matched
      '`${err.name}: ${err.message}`',
      '`${err.message}\\n${err.stack}`',
    ],
    invalid: [
      {
        code: 'const msg = e instanceof Error ? e.message : String(e);',
        errors: [{ messageId: 'inlineError' }],
      },
      {
        code: 'const msg = e.message || String(e);',
        errors: [{ messageId: 'inlineError' }],
      },
      {
        code: 'const msg = e.message ?? String(e);',
        errors: [{ messageId: 'inlineError' }],
      },
    ],
  });

});
