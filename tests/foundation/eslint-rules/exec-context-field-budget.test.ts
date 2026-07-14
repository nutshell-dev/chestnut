import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import execContextFieldBudget from '../../../.config/eslint-rules/exec-context-field-budget.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

function makeInterface(memberCount: number): string {
  const members = Array.from({ length: memberCount }, (_, i) => `  field${i}: string;`).join('\n');
  return `export interface ExecContext {\n${members}\n}`;
}

describe('eslint custom rule: exec-context-field-budget (phase 404)', () => {
  ruleTester.run('exec-context-field-budget', execContextFieldBudget, {
    valid: [
      // out of scope: not types.ts
      {
        code: makeInterface(40),
        filename: 'src/core/runtime/runtime.ts',
      },
      // out of scope: tests/
      {
        code: makeInterface(40),
        filename: 'tests/foo.test.ts',
      },
      // in scope but different interface name
      {
        code: 'export interface OtherContext {\n  ' + Array.from({ length: 40 }, (_, i) => `field${i}: string;`).join('\n  ') + '\n}',
        filename: 'src/foundation/tools/types.ts',
      },
      // in scope, ExecContext, 0 members (current state)
      {
        code: 'export interface ExecContext {}',
        filename: 'src/foundation/tools/types.ts',
      },
      // in scope, ExecContext, exactly 35 members (boundary)
      {
        code: makeInterface(35),
        filename: 'src/foundation/tools/types.ts',
      },
      // in scope, ExecContext extends X (no body) — body.body empty
      {
        code: 'export interface ExecContext extends OtherBase {}',
        filename: 'src/foundation/tools/types.ts',
      },
    ],
    invalid: [
      // ExecContext with 36 members
      {
        code: makeInterface(36),
        filename: 'src/foundation/tools/types.ts',
        errors: [{ messageId: 'execContextOverBudget' }],
      },
      // ExecContext with 50 members
      {
        code: makeInterface(50),
        filename: 'src/foundation/tools/types.ts',
        errors: [{ messageId: 'execContextOverBudget' }],
      },
    ],
  });

});
