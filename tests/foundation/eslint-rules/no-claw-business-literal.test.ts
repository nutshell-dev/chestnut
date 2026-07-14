import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noClawBusinessLiteral from '../../../.config/eslint-rules/no-claw-business-literal.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-claw-business-literal (phase 377)', () => {
  ruleTester.run('no-claw-business-literal', noClawBusinessLiteral, {
    valid: [
      // out of scope: src/core/
      {
        code: 'const clawsDir = "/tmp"; const motion = 1;',
        filename: 'src/core/runtime/runtime.ts',
      },
      // out of scope: src/foundation/messaging/
      {
        code: 'const clawsDir = "/tmp"; const motion = 1;',
        filename: 'src/foundation/messaging/inbox-writer.ts',
      },
      // out of scope: tests/
      {
        code: 'const clawsDir = "/tmp";',
        filename: 'tests/foundation/fs/foo.test.ts',
      },
      // .d.ts skip (pure JS placeholder; rule logic only checks filename suffix)
      {
        code: 'const clawsDir = "x";',
        filename: 'src/foundation/fs/types.d.ts',
      },
      // foundation/fs/ neutral file (no banList token)
      {
        code: 'export function readFile(path) { return path; }',
        filename: 'src/foundation/fs/node-fs.ts',
      },
      // foundation/fs/ uses generic "dir" not "clawsDir"
      {
        code: 'export function readFile(dir) { return dir; }',
        filename: 'src/foundation/fs/node-fs.ts',
      },
      // partial-word `clawing` not a banList token (\b boundary)
      {
        code: 'const clawing = 1;',
        filename: 'src/foundation/fs/node-fs.ts',
      },
      // partial-word `commotion` not flagged
      {
        code: 'const commotion = 1;',
        filename: 'src/foundation/fs/node-fs.ts',
      },
    ],
    invalid: [
      // clawsDir identifier in foundation/fs/
      {
        code: 'const clawsDir = "/tmp";',
        filename: 'src/foundation/fs/node-fs.ts',
        errors: [{ messageId: 'businessTokenLeak' }],
      },
      // motion identifier in foundation/fs/
      {
        code: 'const motion = 1;',
        filename: 'src/foundation/fs/node-fs.ts',
        errors: [{ messageId: 'businessTokenLeak' }],
      },
      // motion string literal
      {
        code: 'const x = "motion";',
        filename: 'src/foundation/fs/node-fs.ts',
        errors: [{ messageId: 'businessTokenLeak' }],
      },
      // clawspace in comment
      {
        code: '// clawspace dir handling\nconst x = 1;',
        filename: 'src/foundation/fs/node-fs.ts',
        errors: [{ messageId: 'businessTokenLeak' }],
      },
      // clawsId in jsdoc
      {
        code: '/**\n * @param clawsId the claw\n */\nfunction f(x) { return x; }',
        filename: 'src/foundation/fs/node-fs.ts',
        errors: [{ messageId: 'businessTokenLeak' }],
      },
      // case-insensitive: Motion
      {
        code: 'const x = "Motion";',
        filename: 'src/foundation/fs/node-fs.ts',
        errors: [{ messageId: 'businessTokenLeak' }],
      },
      // multiple hits → single report w/ all unique matches in msg
      {
        code: 'const clawsDir = "x"; const motion = 1; const clawsId = "y";',
        filename: 'src/foundation/fs/node-fs.ts',
        errors: [{ messageId: 'businessTokenLeak' }],
      },
      // claw root with space
      {
        code: '// inside claw root traversal\nconst x = 1;',
        filename: 'src/foundation/fs/node-fs.ts',
        errors: [{ messageId: 'businessTokenLeak' }],
      },
    ],
  });

});
