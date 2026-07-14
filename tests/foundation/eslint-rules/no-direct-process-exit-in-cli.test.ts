import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noDirectProcessExitInCli from '../../../.config/eslint-rules/no-direct-process-exit-in-cli.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: no-direct-process-exit-in-cli (phase 312)', () => {
  ruleTester.run('no-direct-process-exit-in-cli', noDirectProcessExitInCli, {
    valid: [
      // not in src/cli/
      { code: 'process.exit(1);', filename: 'src/daemon/daemon.ts' },
      // in src/cli/ allow-list
      { code: 'process.exit(1);', filename: 'src/cli/with-cli-error-handling.ts' },
      { code: 'process.exit(1);', filename: 'src/cli/commands/chat-viewport-init.ts' },
      { code: 'process.exit(1);', filename: 'src/cli/commands/subagent-steps.ts' },
      // exitCode (not exit) is OK
      { code: 'process.exitCode = 1;', filename: 'src/cli/commands/fake-cmd.ts' },
    ],
    invalid: [
      {
        code: 'process.exit(1);',
        filename: 'src/cli/commands/fake-cmd.ts',
        errors: [{ messageId: 'directProcessExit' }],
      },
      {
        code: 'function f() { process.exit(2); }',
        filename: 'src/cli/utils/some-helper.ts',
        errors: [{ messageId: 'directProcessExit' }],
      },
    ],
  });

});
