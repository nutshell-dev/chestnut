import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noChatMethod from '../../../.config/eslint-rules/no-chat-method.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-chat-method (phase 377)', () => {
  ruleTester.run('no-chat-method', noChatMethod, {
    valid: [
      // out of src/
      { code: 'runtime.chat(msgs);', filename: 'tests/foo.test.ts' },
      // line-level exemption: claude (LLM provider chat API)
      {
        code: 'const x = claude.chat(msgs);',
        filename: 'src/foundation/llm-provider/anthropic.ts',
      },
      // line-level exemption: anthropic
      {
        code: 'await anthropic.chat({});',
        filename: 'src/foundation/llm-provider/x.ts',
      },
      // line-level exemption: LLM
      {
        code: 'const llmResp = LLM.chat({});',
        filename: 'src/core/runtime/runtime.ts',
      },
      // line-level exemption: messages keyword
      {
        code: 'sdk.chat({ messages: [] });',
        filename: 'src/foundation/llm-provider/x.ts',
      },
      // line-level exemption: comment line (// in line)
      {
        code: '// runtime.chat(msgs) — deprecated\nconst x = 1;',
        filename: 'src/core/runtime/runtime.ts',
      },
      // unrelated chat-like identifier (no `.chat(` invocation)
      {
        code: 'const userChat = "x";',
        filename: 'src/core/runtime/runtime.ts',
      },
      // unrelated method name
      {
        code: 'runtime.process(msgs);',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // business path .chat( invocation
      {
        code: 'runtime.chat(msgs);',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chatMethodReintroduced' }],
      },
      // class chat method definition
      {
        code: 'class Runtime { chat() { return null; } }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chatMethodReintroduced' }],
      },
      // async chat method
      {
        code: 'class Runtime { async chat() { return null; } }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chatMethodReintroduced' }],
      },
      // object literal { chat: function() {} }
      {
        code: 'const obj = { chat: function() { return null; } };',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chatMethodReintroduced' }],
      },
      // object literal { chat: () => {} }
      {
        code: 'const obj = { chat: () => null };',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chatMethodReintroduced' }],
      },
      // object literal shorthand { chat() {} }
      {
        code: 'const obj = { chat() { return null; } };',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'chatMethodReintroduced' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
