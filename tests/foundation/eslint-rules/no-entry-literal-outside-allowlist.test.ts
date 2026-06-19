import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noEntryLiteralOutsideAllowlist from '../../../.config/eslint-rules/no-entry-literal-outside-allowlist.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-entry-literal-outside-allowlist (phase 420)', () => {
  ruleTester.run('no-entry-literal-outside-allowlist', noEntryLiteralOutsideAllowlist, {
    valid: [
      // out of src/
      {
        code: 'const x = "daemon-entry.js";',
        filename: 'tests/foo.test.ts',
      },
      // daemon-entry allowlist: cli/commands/stop.ts
      {
        code: 'const x = "daemon-entry.js";',
        filename: 'src/cli/commands/stop.ts',
      },
      // daemon-entry allowlist: assembly/spawn-entry.ts
      {
        code: 'const x = "daemon-entry.js";',
        filename: 'src/assembly/spawn-entry.ts',
      },
      // daemon-entry allowlist: foundation/process-manager/types.ts
      {
        code: 'const x = "daemon-entry.js";',
        filename: 'src/foundation/process-manager/types.ts',
      },
      // watchdog-entry allowlist
      {
        code: 'const x = "watchdog-entry.js";',
        filename: 'src/watchdog/orphan-sweep.ts',
      },
      // unrelated literal
      {
        code: 'const x = "other.js";',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // daemon-entry outside allowlist
      {
        code: 'const x = "daemon-entry.js";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'daemonEntryLiteral' }],
      },
      // watchdog-entry outside allowlist
      {
        code: 'const x = "watchdog-entry.js";',
        filename: 'src/cli/commands/stop.ts',
        errors: [{ messageId: 'watchdogEntryLiteral' }],
      },
      // template literal containing daemon-entry.js
      {
        code: 'const x = `path/to/daemon-entry.js`;',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'daemonEntryLiteral' }],
      },
      // both literals in same file outside allowlist
      {
        code: 'const x = "daemon-entry.js"; const y = "watchdog-entry.js";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [
          { messageId: 'daemonEntryLiteral' },
          { messageId: 'watchdogEntryLiteral' },
        ],
      },
    ],
  });

  it('rule loaded', () => {});
});
