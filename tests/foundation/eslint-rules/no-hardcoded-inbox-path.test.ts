import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noHardcodedInboxPath from '../../../.config/eslint-rules/no-hardcoded-inbox-path.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: no-hardcoded-inbox-path (phase 315)', () => {
  ruleTester.run('no-hardcoded-inbox-path', noHardcodedInboxPath, {
    valid: [
      // typed helper (messaging owner)
      { code: 'const p = makeInboxPath(absoluteDir);', filename: 'src/foundation/messaging/notify.ts' },
      // allow-list (assembly)
      { code: 'path.join(dir, "inbox", "pending");', filename: 'src/assembly/business-systems.ts' },
      // allow-list (cli)
      { code: 'path.join(dir, "inbox", "pending");', filename: 'src/cli/commands/foo.ts' },
      // allow-list (daemon read/delete)
      { code: 'path.join(dir, "inbox", "pending");', filename: 'src/daemon/daemon.ts' },
      // allow-list (watchdog-utils read-only)
      { code: 'path.join(dir, "inbox", "pending");', filename: 'src/watchdog/watchdog-utils.ts' },
      // path.join 含 inbox 但无 pending
      { code: 'path.join(dir, "inbox");', filename: 'src/core/foo.ts' },
      // path.join 含 pending 但无 inbox
      { code: 'path.join(dir, "pending");', filename: 'src/core/foo.ts' },
    ],
    invalid: [
      {
        code: 'path.join(dir, "inbox", "pending");',
        filename: 'src/core/contract/_helper.ts',
        errors: [{ messageId: 'hardcodedInboxPath' }],
      },
      {
        code: 'path.join(dir, "inbox", "pending", filename);',
        filename: 'src/foundation/cron/jobs/foo.ts',
        errors: [{ messageId: 'hardcodedInboxPath' }],
      },
    ],
  });

  it('rule loaded', () => {
    // dummy test for vitest describe completeness
  });
});
