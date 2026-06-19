import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noReadonlyAndSupportsAsyncTool from '../../../.config/eslint-rules/no-readonly-and-supportsasync-tool.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-readonly-and-supportsasync-tool (phase 401)', () => {
  ruleTester.run('no-readonly-and-supportsasync-tool', noReadonlyAndSupportsAsyncTool, {
    valid: [
      // out of src/
      {
        code: 'const tool = { readonly: true, supportsAsync: true };',
        filename: 'tests/foo.test.ts',
      },
      // allowlist: search.ts
      {
        code: 'const tool = { readonly: true, supportsAsync: true };',
        filename: 'src/foundation/file-tool/search.ts',
      },
      // allowlist: memory_search.ts
      {
        code: 'const tool = { readonly: true, supportsAsync: true };',
        filename: 'src/core/memory/tools/memory_search.ts',
      },
      // readonly only
      {
        code: 'const tool = { readonly: true };',
        filename: 'src/foundation/file-tool/read.ts',
      },
      // supportsAsync only
      {
        code: 'const tool = { supportsAsync: true };',
        filename: 'src/core/runtime/runtime.ts',
      },
      // readonly false + supportsAsync true (no violation)
      {
        code: 'const tool = { readonly: false, supportsAsync: true };',
        filename: 'src/core/runtime/runtime.ts',
      },
      // readonly true + supportsAsync false (no violation)
      {
        code: 'const tool = { readonly: true, supportsAsync: false };',
        filename: 'src/foundation/file-tool/read.ts',
      },
      // .d.ts skip
      {
        code: 'const tool = { readonly: true, supportsAsync: true };',
        filename: 'src/types.d.ts',
      },
    ],
    invalid: [
      // business path: both true
      {
        code: 'const tool = { readonly: true, supportsAsync: true };',
        filename: 'src/foundation/file-tool/read.ts',
        errors: [{ messageId: 'readonlyAndSupportsAsync' }],
      },
      // mixed order
      {
        code: 'const tool = { supportsAsync: true, readonly: true };',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'readonlyAndSupportsAsync' }],
      },
      // with other props
      {
        code: 'const tool = { name: "foo", readonly: true, profile: "x", supportsAsync: true };',
        filename: 'src/foundation/tools/types.ts',
        errors: [{ messageId: 'readonlyAndSupportsAsync' }],
      },
      // string keys
      {
        code: 'const tool = { "readonly": true, "supportsAsync": true };',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'readonlyAndSupportsAsync' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
