import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import auditCapConstScope from '../../../.config/eslint-rules/audit-cap-const-scope.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: audit-cap-const-scope (phase 330)', () => {
  ruleTester.run('audit-cap-const-scope', auditCapConstScope, {
    valid: [
      // inside foundation/audit/: allowed
      {
        code: 'export const AUDIT_PREVIEW_LEN = 100;',
        filename: 'src/foundation/audit/defaults.ts',
      },
      {
        code: 'import { AUDIT_PREVIEW_LEN } from "./defaults.js";',
        filename: 'src/foundation/audit/writer.ts',
      },
      // unrelated identifier outside audit/
      {
        code: 'const x = 1;',
        filename: 'src/foundation/constants.ts',
      },
      {
        code: 'const PREVIEW = 10;',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // outside audit/ uses AUDIT_PREVIEW_LEN
      {
        code: 'const x = AUDIT_PREVIEW_LEN;',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'auditCapOutsideScope' }],
      },
      // outside audit/ uses AUDIT_MESSAGE_MAX_CHARS (import: 2 errors imported+local binding)
      {
        code: 'import { AUDIT_MESSAGE_MAX_CHARS } from "./somewhere.js";',
        filename: 'src/foundation/constants.ts',
        errors: [
          { messageId: 'auditCapOutsideScope' },
          { messageId: 'auditCapOutsideScope' },
        ],
      },
      // foundation/constants.ts re-defines AUDIT_PREVIEW_LEN
      {
        code: 'export const AUDIT_PREVIEW_LEN = 100;',
        filename: 'src/foundation/constants.ts',
        errors: [{ messageId: 'auditCapOutsideScope' }],
      },
    ],
  });

});
