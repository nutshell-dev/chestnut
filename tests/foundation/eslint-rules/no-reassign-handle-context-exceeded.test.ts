import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noReassignHandleContextExceeded from '../../../.config/eslint-rules/no-reassign-handle-context-exceeded.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-reassign-handle-context-exceeded (phase 399)', () => {
  ruleTester.run('no-reassign-handle-context-exceeded', noReassignHandleContextExceeded, {
    valid: [
      // out of src/
      {
        code: 'messages = handleContextExceeded(ctx);',
        filename: 'tests/foo.test.ts',
      },
      // allowlist file: exceeded.ts (helper own return / type)
      {
        code: 'let messages = handleContextExceeded(ctx);',
        filename: 'src/core/l4_context_manager/exceeded.ts',
      },
      // correct pattern: const callView = handleContextExceeded(...)
      {
        code: 'const callView = handleContextExceeded(ctx);',
        filename: 'src/core/runtime/runtime.ts',
      },
      // unrelated function call
      {
        code: 'messages = doSomethingElse(ctx);',
        filename: 'src/core/runtime/runtime.ts',
      },
      // handleContextExceeded result used differently
      {
        code: 'const out = handleContextExceeded(ctx); processOptions({ messages: out.messages });',
        filename: 'src/core/runtime/runtime.ts',
      },
      // return statement is not assignment
      {
        code: 'function f() { return handleContextExceeded(ctx); }',
        filename: 'src/core/runtime/runtime.ts',
      },
      // .d.ts skip
      {
        code: 'let messages = handleContextExceeded(ctx);',
        filename: 'src/types.d.ts',
      },
      // assignment to non-messages name
      {
        code: 'let payload = handleContextExceeded(ctx);',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // VariableDeclarator: let messages = handleContextExceeded(...)
      {
        code: 'let messages = handleContextExceeded(ctx);',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'messagesReassignFromHandleContextExceeded' }],
      },
      // VariableDeclarator: const messages = handleContextExceeded(...)
      {
        code: 'const messages = handleContextExceeded(ctx);',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'messagesReassignFromHandleContextExceeded' }],
      },
      // AssignmentExpression: messages = handleContextExceeded(...)
      {
        code: 'let messages = []; messages = handleContextExceeded(ctx);',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'messagesReassignFromHandleContextExceeded' }],
      },
      // MemberExpression: this.messages = handleContextExceeded(...)
      {
        code: 'class R { run(ctx) { this.messages = handleContextExceeded(ctx); } }',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'messagesReassignFromHandleContextExceeded' }],
      },
      // MemberExpression: ctx.messages = handleContextExceeded(...)
      {
        code: 'function f(ctx) { ctx.messages = handleContextExceeded(ctx); }',
        filename: 'src/core/step-executor/step-executor.ts',
        errors: [{ messageId: 'messagesReassignFromHandleContextExceeded' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
