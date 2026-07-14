import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noDirectFsWriteatomicToInbox from '../../../.config/eslint-rules/no-direct-fs-writeatomic-to-inbox.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: no-direct-fs-writeatomic-to-inbox (phase 315)', () => {
  ruleTester.run('no-direct-fs-writeatomic-to-inbox', noDirectFsWriteatomicToInbox, {
    valid: [
      // not in 5 scan dir
      { code: 'fs.writeAtomic("/inbox/msg.md", content);', filename: 'src/cli/foo.ts' },
      // 5 scan dir but allow-list (messaging owner)
      { code: 'fs.writeAtomic("/inbox/msg.md", content);', filename: 'src/foundation/messaging/inbox-writer.ts' },
      // 5 scan dir but path 不含 inbox
      { code: 'fs.writeAtomic("/somewhere/foo.md", content);', filename: 'src/core/contract/_helper.ts' },
      // 5 scan dir 但用 InboxWriter
      { code: 'inboxWriter.write(msg);', filename: 'src/core/contract/_helper.ts' },
    ],
    invalid: [
      // string literal
      {
        code: 'fs.writeAtomic("/path/to/inbox/msg.md", content);',
        filename: 'src/core/contract/_helper.ts',
        errors: [{ messageId: 'directInboxWrite' }],
      },
      // template literal
      {
        code: 'fs.writeAtomic(`${dir}/inbox/${name}`, content);',
        filename: 'src/foundation/cron/jobs/foo.ts',
        errors: [{ messageId: 'directInboxWrite' }],
      },
      // memory/ dir
      {
        code: 'fs.writeAtomic("/inbox/dream.md", content);',
        filename: 'src/core/memory/random-dream.ts',
        errors: [{ messageId: 'directInboxWrite' }],
      },
    ],
  });

});
