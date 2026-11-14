import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noHardcodedInboxPath from '../../../.config/eslint-rules/no-hardcoded-inbox-path.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: no-hardcoded-inbox-path (Phase 2147 B2)', () => {
  ruleTester.run('no-hardcoded-inbox-path', noHardcodedInboxPath, {
    valid: [
      { code: 'const writer = createInboxWriter(fs, clawRoot, audit, limits);', filename: 'src/assembly/business-systems.ts' },
      { code: 'const target = makeInboxTarget(clawRoot);', filename: 'src/core/event-loop/inbox-watcher.ts' },
      { code: 'path.join(dir, "inbox", "pending");', filename: 'src/foundation/messaging/dirs.ts' },
      { code: 'path.join(dir, "inbox");', filename: 'src/core/foo.ts' },
      { code: 'path.join(dir, "pending");', filename: 'src/core/foo.ts' },
    ],
    invalid: [
      ...['src/assembly/business-systems.ts', 'src/cli/commands/foo.ts', 'src/daemon/daemon.ts', 'src/watchdog/watchdog-utils.ts', 'src/core/foo.ts'].map(filename => ({
        code: 'path.join(dir, "inbox", "pending");',
        filename,
        errors: [{ messageId: 'hardcodedInboxPath' }],
      })),
      {
        code: 'path.join(dir, "outbox", "processing");',
        filename: 'src/core/foo.ts',
        errors: [{ messageId: 'hardcodedInboxPath' }],
      },
      {
        code: 'import { INBOX_PENDING_DIR } from "../../foundation/messaging/index.js";',
        filename: 'src/core/foo.ts',
        errors: [{ messageId: 'messagingLeafEscape' }],
      },
      {
        code: 'InboxWriter.__internal_create(fs, dir, audit, limits);',
        filename: 'src/core/foo.ts',
        errors: [{ messageId: 'messagingLeafEscape' }],
      },
    ],
  });
});
