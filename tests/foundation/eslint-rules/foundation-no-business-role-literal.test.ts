import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import foundationNoBusinessRoleLiteral from '../../../.config/eslint-rules/foundation-no-business-role-literal.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: foundation-no-business-role-literal (phase 330 + phase 384 ext L1-L4)', () => {
  ruleTester.run('foundation-no-business-role-literal', foundationNoBusinessRoleLiteral, {
    valid: [
      // out of L1-L4 scope: cli/
      { code: 'const x = "motion";', filename: 'src/cli/commands/x.ts' },
      // out of L1-L4 scope: assembly/
      { code: 'const x = "motion";', filename: 'src/assembly/assemble.ts' },
      // foundation allow-list file
      { code: 'const x = "motion";', filename: 'src/foundation/tools/types.ts' },
      // foundation allow-list file (newly added in phase 384)
      { code: 'const x = "motion";', filename: 'src/foundation/messaging/notify.ts' },
      // core allow-list file
      { code: 'const x = "motion";', filename: 'src/core/runtime/runtime.ts' },
      // foundation/audit/ (not allow-list, no banned literal)
      { code: 'const x = "hello";', filename: 'src/foundation/audit/events.ts' },
      // foundation/audit/ + non-business word
      { code: 'const x = "audit";', filename: 'src/foundation/audit/events.ts' },
      // tool-protocol/ but export of non-banned
      { code: 'export const Foo = "string";', filename: 'src/foundation/tool-protocol/index.ts' },
      // core/ non-allow-list + non-banned literal
      { code: 'const x = "hello";', filename: 'src/core/contract/manager.ts' },
    ],
    invalid: [
      // tool-protocol: business role literal
      {
        code: 'const x = "motion";',
        filename: 'src/foundation/tool-protocol/index.ts',
        errors: [{ messageId: 'businessLiteral' }],
      },
      // tool-protocol: declare banned identifier (callerTypeToProfile)
      {
        code: 'export const callerTypeToProfile = (x) => x;',
        filename: 'src/foundation/tool-protocol/index.ts',
        errors: [{ messageId: 'callerTypeReexport' }],
      },
      // foundation/ non-allow-list: claw literal
      {
        code: 'const x = "claw";',
        filename: 'src/foundation/audit/events.ts',
        errors: [{ messageId: 'businessLiteral' }],
      },
      // foundation/ non-allow-list: subagent literal in template
      {
        code: 'const x = `subagent`;',
        filename: 'src/foundation/audit/events.ts',
        errors: [{ messageId: 'businessLiteral' }],
      },
      // phase 384 ext: core/ non-allow-list: motion literal
      {
        code: 'const x = "motion";',
        filename: 'src/core/contract/manager.ts',
        errors: [{ messageId: 'businessLiteral' }],
      },
      // phase 384 ext: core/ non-allow-list: MOTION_CLAW_ID identifier
      {
        code: 'const x = MOTION_CLAW_ID;',
        filename: 'src/core/contract/manager.ts',
        errors: [{ messageId: 'motionClawIdIdentifier' }],
      },
      // phase 384 ext: foundation/ non-allow-list: MOTION_CLAW_ID identifier
      {
        code: 'const x = MOTION_CLAW_ID;',
        filename: 'src/foundation/audit/events.ts',
        errors: [{ messageId: 'motionClawIdIdentifier' }],
      },
      // phase 384 ext: tool-protocol: MOTION_CLAW_ID (strict)
      {
        code: 'const x = MOTION_CLAW_ID;',
        filename: 'src/foundation/tool-protocol/index.ts',
        errors: [{ messageId: 'motionClawIdIdentifier' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
