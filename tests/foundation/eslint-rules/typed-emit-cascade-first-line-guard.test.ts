import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import typedEmitCascadeFirstLineGuard from '../../../.config/eslint-rules/typed-emit-cascade-first-line-guard.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: typed-emit-cascade-first-line-guard (phase 424)', () => {
  ruleTester.run('typed-emit-cascade-first-line-guard', typedEmitCascadeFirstLineGuard, {
    valid: [
      // out of scope
      {
        code:
          'export function emitContractFoo(audit: AuditLog, opts: { contractId: string }): void {\n' +
          '  doSomething();\n' +
          '}',
        filename: 'src/core/contract/other.ts',
      },
      // in scope, correct guard
      {
        code:
          "export function emitContractLockCleared(audit: AuditLog, opts: { contractId: string; clawId: string }): void {\n" +
          "  assertContractIdNonEmpty(audit, opts.contractId, 'emitContractLockCleared');\n" +
          "  audit.write('CONTRACT_LOCK_CLEARED', 'contractId=' + opts.contractId);\n" +
          "}",
        filename: 'src/core/contract/audit-emit.ts',
      },
      // in scope, no contractId in opts (rule shouldn't fire)
      {
        code:
          "export function emitContractMisc(audit: AuditLog, opts: { foo: string }): void {\n" +
          "  audit.write('X', 'foo=' + opts.foo);\n" +
          "}",
        filename: 'src/core/contract/audit-emit.ts',
      },
      // in scope but not emitContract* fn
      {
        code:
          "export function helperFoo(audit: AuditLog, opts: { contractId: string }): void {\n" +
          "  audit.write('X');\n" +
          "}",
        filename: 'src/core/contract/audit-emit.ts',
      },
    ],
    invalid: [
      // missing guard entirely
      {
        code:
          "export function emitContractFooBar(audit: AuditLog, opts: { contractId: string }): void {\n" +
          "  audit.write('X');\n" +
          "}",
        filename: 'src/core/contract/audit-emit.ts',
        errors: [{ messageId: 'missingFirstLineGuard' }],
      },
      // wrong fn name in guard literal
      {
        code:
          "export function emitContractFooBar(audit: AuditLog, opts: { contractId: string }): void {\n" +
          "  assertContractIdNonEmpty(audit, opts.contractId, 'wrong_name');\n" +
          "}",
        filename: 'src/core/contract/audit-emit.ts',
        errors: [{ messageId: 'missingFirstLineGuard' }],
      },
      // guard not first line
      {
        code:
          "export function emitContractFooBar(audit: AuditLog, opts: { contractId: string }): void {\n" +
          "  const x = 1;\n" +
          "  assertContractIdNonEmpty(audit, opts.contractId, 'emitContractFooBar');\n" +
          "}",
        filename: 'src/core/contract/audit-emit.ts',
        errors: [{ messageId: 'missingFirstLineGuard' }],
      },
      // wrong first arg (not audit)
      {
        code:
          "export function emitContractFooBar(audit: AuditLog, opts: { contractId: string }): void {\n" +
          "  assertContractIdNonEmpty(other, opts.contractId, 'emitContractFooBar');\n" +
          "}",
        filename: 'src/core/contract/audit-emit.ts',
        errors: [{ messageId: 'missingFirstLineGuard' }],
      },
    ],
  });

});
