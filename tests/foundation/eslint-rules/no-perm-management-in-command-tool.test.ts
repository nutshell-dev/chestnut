import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noPermManagementInCommandTool from '../../../.config/eslint-rules/no-perm-management-in-command-tool.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('eslint custom rule: no-perm-management-in-command-tool (phase 322)', () => {
  ruleTester.run('no-perm-management-in-command-tool', noPermManagementInCommandTool, {
    valid: [
      // (1)(2) identifier outside command-tool/
      { code: 'const allowList = [];', filename: 'src/core/permissions/checker.ts' },
      { code: 'const denyList = [];', filename: 'src/core/permissions/checker.ts' },
      // command-tool/ but identifier not allowList/denyList
      { code: 'const allowedCmd = "ls";', filename: 'src/foundation/command-tool/exec.ts' },
      { code: 'const whitelist = [];', filename: 'src/foundation/command-tool/exec.ts' },
      // (3) string literal not the rejected event
      { code: 'const e = "command_tool_other_event";', filename: 'src/foundation/audit/events.ts' },
      { code: 'audit.write("command_executed", x);', filename: 'src/foundation/command-tool/exec.ts' },
    ],
    invalid: [
      // (1) allowList in command-tool/
      {
        code: 'const allowList = ["ls"];',
        filename: 'src/foundation/command-tool/exec.ts',
        errors: [{ messageId: 'permIdentifier', data: { name: 'allowList' } }],
      },
      // (2) denyList in command-tool/
      {
        code: 'const denyList = ["rm"];',
        filename: 'src/foundation/command-tool/exec.ts',
        errors: [{ messageId: 'permIdentifier', data: { name: 'denyList' } }],
      },
      // (3) rejected event literal anywhere in src/
      {
        code: 'audit.write("command_tool_command_rejected", x);',
        filename: 'src/foundation/audit/events.ts',
        errors: [{ messageId: 'rejectedEvent' }],
      },
      // (3) rejected event in command-tool/ (also (3) hit, not (1)(2))
      {
        code: 'const e = "command_tool_command_rejected";',
        filename: 'src/foundation/command-tool/exec.ts',
        errors: [{ messageId: 'rejectedEvent' }],
      },
    ],
  });

});
