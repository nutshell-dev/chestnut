import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noChestnutDirNaming from '../../../.config/eslint-rules/no-chestnut-dir-naming.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-chestnut-dir-naming (phase 378)', () => {
  ruleTester.run('no-chestnut-dir-naming', noChestnutDirNaming, {
    valid: [
      // out of src/
      { code: 'const chestnutDir = "/tmp";', filename: 'tests/foo.test.ts' },
      // .d.ts skip (pure JS placeholder; rule logic only checks filename suffix)
      { code: 'const chestnutDir = "x";', filename: 'src/types.d.ts' },
      // canonical name `chestnutRoot`
      {
        code: 'const chestnutRoot = "/tmp";',
        filename: 'src/core/runtime/runtime.ts',
      },
      // similar but different identifier
      {
        code: 'const chestnutDirty = 1;',
        filename: 'src/core/runtime/runtime.ts',
      },
      // unrelated dir suffix
      {
        code: 'const tmpDir = "/tmp";',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // const declaration
      {
        code: 'const chestnutDir = "/tmp";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chestnutDirReintroduced' }],
      },
      // property access
      {
        code: 'const x = ctx.chestnutDir;',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chestnutDirReintroduced' }],
      },
      // function param
      {
        code: 'function f(chestnutDir) { return chestnutDir; }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [
          { messageId: 'chestnutDirReintroduced' },
          { messageId: 'chestnutDirReintroduced' },
        ],
      },
      // class method
      {
        code: 'class R { chestnutDir() { return ""; } }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chestnutDirReintroduced' }],
      },
      // import name (Identifier visitor fires 2× per phase 353 lesson)
      {
        code: 'import { chestnutDir } from "./other.js";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [
          { messageId: 'chestnutDirReintroduced' },
          { messageId: 'chestnutDirReintroduced' },
        ],
      },
    ],
  });

  it('rule loaded', () => {});
});
