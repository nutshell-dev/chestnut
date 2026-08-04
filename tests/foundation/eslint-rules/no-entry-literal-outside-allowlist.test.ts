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
      // daemon-entry allowlist: daemon/entry-resolver.ts (phase 1284 归位 Daemon)
      {
        code: 'const x = "daemon-entry.js";',
        filename: 'src/daemon/entry-resolver.ts',
      },
      // daemon-entry allowlist: foundation/process-manager/types.ts
      {
        code: 'const x = "daemon-entry.js";',
        filename: 'src/foundation/process-manager/types.ts',
      },
      // watchdog-entry allowlist: watchdog/entry-resolver.ts (phase 1285 归位 Watchdog)
      {
        code: 'const x = "watchdog-entry.js";',
        filename: 'src/watchdog/entry-resolver.ts',
      },
      // watchdog-entry allowlist: orphan-sweep.ts (argv 校验 token)
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
      // phase 1284: daemon-entry literal 在旧 owner assembly/spawn-entry.ts 不再合法
      {
        code: 'const x = "daemon-entry.js";',
        filename: 'src/assembly/spawn-entry.ts',
        errors: [{ messageId: 'daemonEntryLiteral' }],
      },
      // watchdog-entry outside allowlist
      {
        code: 'const x = "watchdog-entry.js";',
        filename: 'src/cli/commands/stop.ts',
        errors: [{ messageId: 'watchdogEntryLiteral' }],
      },
      // phase 1285: watchdog-entry literal 在旧 owner assembly/spawn-entry.ts 不再合法
      {
        code: 'const x = "watchdog-entry.js";',
        filename: 'src/assembly/spawn-entry.ts',
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

});
