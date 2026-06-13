import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noRuntimeCurrentStateGetter from '../../../.config/eslint-rules/no-runtime-current-state-getter.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-runtime-current-state-getter (phase 353)', () => {
  ruleTester.run('no-runtime-current-state-getter', noRuntimeCurrentStateGetter, {
    valid: [
      // out of src/
      { code: 'const x = getCurrentTools();', filename: 'tests/foo.test.ts' },
      // .d.ts skip (pure JS placeholder; rule logic only checks filename suffix)
      { code: 'const getCurrentTools = () => {};', filename: 'src/types.d.ts' },
      // similar but different identifier
      {
        code: 'const x = getTools();',
        filename: 'src/core/runtime/runtime.ts',
      },
      // unrelated current* identifier
      {
        code: 'const x = getCurrentDir();',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // method call
      {
        code: 'const x = runtime.getCurrentSystemPrompt();',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'mirrorGetterReintroduced' }],
      },
      // standalone function call
      {
        code: 'const t = getCurrentTools();',
        filename: 'src/core/contract/manager.ts',
        errors: [{ messageId: 'mirrorGetterReintroduced' }],
      },
      // property access
      {
        code: 'const fn = runtime.getCurrentMessages;',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'mirrorGetterReintroduced' }],
      },
      // method definition shape
      {
        code: 'class R { getCurrentTools() { return []; } }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'mirrorGetterReintroduced' }],
      },
      // import name (ImportSpecifier identifier + local identifier — Identifier visitor fires 2×)
      {
        code: 'import { getCurrentSystemPrompt } from "./other.js";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [
          { messageId: 'mirrorGetterReintroduced' },
          { messageId: 'mirrorGetterReintroduced' },
        ],
      },
    ],
  });

  it('rule loaded', () => {});
});
