import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noDirectNewNodeFileSystem from '../../../.config/eslint-rules/no-direct-new-nodefilesystem.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-direct-new-nodefilesystem (phase 359)', () => {
  ruleTester.run('no-direct-new-nodefilesystem', noDirectNewNodeFileSystem, {
    valid: [
      // out of src/
      { code: 'const fs = new NodeFileSystem({ baseDir });', filename: 'tests/foo.test.ts' },
      // allowlist: daemon-entry.ts
      {
        code: 'const fs = new NodeFileSystem({ baseDir });',
        filename: 'src/daemon-entry.ts',
      },
      // allowlist: watchdog-entry.ts
      {
        code: 'const fs = new NodeFileSystem({ baseDir });',
        filename: 'src/watchdog-entry.ts',
      },
      // allowlist: cli/index.ts
      {
        code: 'const fs = new NodeFileSystem({ baseDir });',
        filename: 'src/cli/index.ts',
      },
      // allowlist: assembly/assemble.ts
      {
        code: 'const fs = new NodeFileSystem({ baseDir });',
        filename: 'src/assembly/assemble.ts',
      },
      // allowlist: assembly/core-infrastructure.ts
      {
        code: 'const fs = new NodeFileSystem({ baseDir });',
        filename: 'src/assembly/core-infrastructure.ts',
      },
      // allowlist: foundation/fs/ prefix
      {
        code: 'const fs = new NodeFileSystem({ baseDir });',
        filename: 'src/foundation/fs/factory.ts',
      },
      // unrelated `new` expression
      {
        code: 'const m = new Map();',
        filename: 'src/core/runtime/runtime.ts',
      },
      // function call (not new)
      {
        code: 'const fs = NodeFileSystem({ baseDir });',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // business path direct construction
      {
        code: 'const fs = new NodeFileSystem({ baseDir });',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'directNewNodeFileSystem' }],
      },
      // in factory function outside allowlist
      {
        code: 'function make() { return new NodeFileSystem({ baseDir: "/" }); }',
        filename: 'src/foundation/messaging/inbox-writer.ts',
        errors: [{ messageId: 'directNewNodeFileSystem' }],
      },
      // cli command file (not cli/index.ts)
      {
        code: 'const fs = new NodeFileSystem({ baseDir });',
        filename: 'src/cli/commands/foo.ts',
        errors: [{ messageId: 'directNewNodeFileSystem' }],
      },
    ],
  });

});
