import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import formatterParity from '../../../.config/eslint-rules/formatter-parity-require-constants.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: formatter-parity-require-constants (phase 329)', () => {
  ruleTester.run('formatter-parity-require-constants', formatterParity, {
    valid: [
      // out of scope (not a formatter file)
      { code: 'const x = 1;', filename: 'src/foundation/llm-provider/anthropic.ts' },
      { code: 'const x = 1;', filename: 'src/core/runtime/runtime.ts' },

      // base-anthropic.ts with all 3 required constants
      {
        code:
          'const a = EVENTS.TOOL_RESULT_MISSING_ID;\n' +
          'const b = EVENTS.TOOL_RESULT_ORPHAN_ID;\n' +
          'const c = EVENTS.ASSISTANT_EMPTY_CONTENT_SKIPPED;',
        filename: 'src/foundation/llm-provider/base-anthropic.ts',
      },

      // openai-message-formatter.ts with 2 required constants
      {
        code:
          'const a = EVENTS.TOOL_RESULT_MISSING_ID;\n' +
          'const b = EVENTS.TOOL_RESULT_ORPHAN_ID;',
        filename: 'src/foundation/llm-provider/openai-message-formatter.ts',
      },
    ],
    invalid: [
      // base-anthropic.ts missing ASSISTANT_EMPTY_CONTENT_SKIPPED
      {
        code:
          'const a = EVENTS.TOOL_RESULT_MISSING_ID;\n' +
          'const b = EVENTS.TOOL_RESULT_ORPHAN_ID;',
        filename: 'src/foundation/llm-provider/base-anthropic.ts',
        errors: [{ messageId: 'missingConstant', data: { file: 'foundation/llm-provider/base-anthropic.ts', name: 'ASSISTANT_EMPTY_CONTENT_SKIPPED' } }],
      },
      // base-anthropic.ts missing all 3
      {
        code: 'const x = 1;',
        filename: 'src/foundation/llm-provider/base-anthropic.ts',
        errors: [
          { messageId: 'missingConstant' },
          { messageId: 'missingConstant' },
          { messageId: 'missingConstant' },
        ],
      },
      // openai-message-formatter.ts missing TOOL_RESULT_ORPHAN_ID
      {
        code: 'const a = EVENTS.TOOL_RESULT_MISSING_ID;',
        filename: 'src/foundation/llm-provider/openai-message-formatter.ts',
        errors: [{ messageId: 'missingConstant' }],
      },
    ],
  });

});
