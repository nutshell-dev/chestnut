import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noDirectErrnoCodeCompare from '../../../.config/eslint-rules/no-direct-errno-code-compare.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: no-direct-errno-code-compare (phase 312)', () => {
  ruleTester.run('no-direct-errno-code-compare', noDirectErrnoCodeCompare, {
    valid: [
      // typed helper
      { code: 'if (isFileNotFound(err)) { handle(); }', filename: 'src/core/contract/_helper.ts' },
      // instanceof
      { code: 'if (err instanceof FileNotFoundError) { handle(); }', filename: 'src/core/contract/_helper.ts' },
      // allow-list file
      { code: 'if (err.code === "ENOENT") {}', filename: 'src/foundation/fs/types.ts' },
      { code: 'if (err.code !== "ENOENT") {}', filename: 'src/foundation/fs/node-fs.ts' },
      // not ENOENT
      { code: 'if (err.code === "ECONNREFUSED") {}', filename: 'src/core/contract/_helper.ts' },
    ],
    invalid: [
      {
        code: 'if (err.code === "ENOENT") { handle(); }',
        filename: 'src/core/contract/_helper.ts',
        errors: [{ messageId: 'directErrnoCompare' }],
      },
      {
        code: 'if (err.code !== "ENOENT") { handle(); }',
        filename: 'src/core/runtime/_helper.ts',
        errors: [{ messageId: 'directErrnoCompare' }],
      },
      {
        code: 'if ("ENOENT" === err.code) { handle(); }',
        filename: 'src/core/status-service/_helper.ts',
        errors: [{ messageId: 'directErrnoCompare' }],
      },
    ],
  });

});
