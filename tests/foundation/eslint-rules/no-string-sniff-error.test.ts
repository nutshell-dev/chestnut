import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noStringSniffError from '../../../.config/eslint-rules/no-string-sniff-error.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
});

describe('eslint custom rule: no-string-sniff-error (phase 312)', () => {
  ruleTester.run('no-string-sniff-error', noStringSniffError, {
    valid: [
      // typed instanceof check
      'if (err instanceof LockConflictError) { handle(); }',
      // not on .message
      'someString.includes("foo");',
      // .message but not includes/match
      'console.log(err.message);',
    ],
    invalid: [
      {
        code: 'if (err.message.includes("already running")) { handle(); }',
        errors: [{ messageId: 'stringSniff' }],
      },
      {
        code: 'if (e.message.match(/already running/)) { handle(); }',
        errors: [{ messageId: 'stringSniff' }],
      },
      {
        code: 'const found = error.message.includes(needle);',
        errors: [{ messageId: 'stringSniff' }],
      },
    ],
  });

});
