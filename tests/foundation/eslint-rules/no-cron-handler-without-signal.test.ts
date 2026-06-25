import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noCronHandlerWithoutSignal from '../../../.config/eslint-rules/no-cron-handler-without-signal.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-cron-handler-without-signal (phase 423)', () => {
  ruleTester.run('no-cron-handler-without-signal', noCronHandlerWithoutSignal, {
    valid: [
      // out of scope
      {
        code: 'const job = { handler: () => null };',
        filename: 'src/core/runtime/runtime.ts',
      },
      // out of scope: tests
      {
        code: 'const job = { handler: () => null };',
        filename: 'tests/foo.test.ts',
      },
      // in scope with signal param
      {
        code: 'const job = { handler: (signal) => null };',
        filename: 'src/foundation/cron/jobs/dream-trigger.ts',
      },
      // contract jobs scope with signal
      {
        code: 'const job = { handler: async (signal) => null };',
        filename: 'src/core/contract/jobs/observer.ts',
      },
    ],
    invalid: [
      // contract jobs scope
      {
        code: 'const job = { handler: () => null };',
        filename: 'src/core/contract/jobs/contract-observer.ts',
        errors: [{ messageId: 'cronHandlerNoSignal' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
