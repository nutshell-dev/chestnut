import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import foundationDirectoryModule from '../../../.config/eslint-rules/foundation-directory-module.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: foundation-directory-module (phase 717)', () => {
  ruleTester.run('foundation-directory-module', foundationDirectoryModule, {
    valid: [
      // out of scope
      { code: '// no op', filename: '/project/src/assembly/config/config-load.ts' },
      // registered directory, matching @module
      {
        code: '/**\n * @module L1.ProcessExec\n */\nexport const a = 1;',
        filename: '/project/src/foundation/process-exec/index.ts',
      },
      // registered directory, matching @module with sub-suffix
      {
        code: '/**\n * @module L2c.FileTool.ZodHelper\n */\nexport const a = 1;',
        filename: '/project/src/foundation/file-tool/_zod-helper.ts',
      },
      // registered directory, no @module
      {
        code: 'export const a = 1;',
        filename: '/project/src/foundation/transport/utils.ts',
      },
      // nested under registered directory
      {
        code: '/**\n * @module L2a.AuditLog.AuditSizeMonitor\n */\nexport const a = 1;',
        filename: '/project/src/foundation/audit/jobs/audit-size-monitor.ts',
      },
    ],
    invalid: [
      // standalone .ts at foundation root
      {
        code: 'export const a = 1;',
        filename: '/project/src/foundation/test.ts',
        errors: [{ messageId: 'noRootFiles' }],
      },
      // unregistered directory
      {
        code: 'export const a = 1;',
        filename: '/project/src/foundation/unknown-dir/index.ts',
        errors: [{ messageId: 'unknownDirectory' }],
      },
      // mismatched @module
      {
        code: '/**\n * @module L2b.Stream\n */\nexport const a = 1;',
        filename: '/project/src/foundation/file-tool/index.ts',
        errors: [{ messageId: 'moduleMismatch' }],
      },
      // mismatched @module sub-suffix base
      {
        code: '/**\n * @module L1.FileSystem.Utils\n */\nexport const a = 1;',
        filename: '/project/src/foundation/process-exec/env-scrub.ts',
        errors: [{ messageId: 'moduleMismatch' }],
      },
    ],
  });

});
