import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noFilenameTag from '../../../.config/eslint-rules/no-filename-tag.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-filename-tag (phase 382)', () => {
  ruleTester.run('no-filename-tag', noFilenameTag, {
    valid: [
      // out of src/
      { code: 'const filenameTag = "x";', filename: 'tests/foo.test.ts' },
      // .d.ts skip
      { code: 'const filenameTag = "x";', filename: 'src/types.d.ts' },
      // unrelated identifier
      { code: 'const filename = "x";', filename: 'src/core/runtime/runtime.ts' },
      { code: 'const filenameTagger = "x";', filename: 'src/core/runtime/runtime.ts' },
      // unrelated string
      { code: 'const x = "filename_tag";', filename: 'src/core/runtime/runtime.ts' },
    ],
    invalid: [
      // identifier
      {
        code: 'const filenameTag = "x";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'filenameTagReintroduced' }],
      },
      // property access
      {
        code: 'const x = msg.filenameTag;',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'filenameTagReintroduced' }],
      },
      // string literal
      {
        code: 'const x = "filenameTag";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'filenameTagReintroduced' }],
      },
      // jsdoc reference
      {
        code: '/**\n * @field filenameTag dead\n */\nfunction f() {}',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'filenameTagReintroduced' }],
      },
      // line comment
      {
        code: '// filenameTag is dead\nconst x = 1;',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'filenameTagReintroduced' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
