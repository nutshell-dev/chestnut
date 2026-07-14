import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noRuntimeKnowsUpperLayer from '../../../.config/eslint-rules/no-runtime-knows-upper-layer-messages.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-runtime-knows-upper-layer-messages (phase 383)', () => {
  ruleTester.run('no-runtime-knows-upper-layer-messages', noRuntimeKnowsUpperLayer, {
    valid: [
      // out of scope: src/core/contract/
      {
        code: 'const x = "claw_crashed";',
        filename: 'src/core/contract/manager.ts',
      },
      // out of scope: tests/
      {
        code: 'const x = "claw_crashed";',
        filename: 'tests/foo.test.ts'
      },
      // in scope but unrelated literal
      {
        code: 'const x = "inbox";',
        filename: 'src/core/runtime/runtime.ts',
      },
      // barrel re-export from runtime/index.ts allowed
      {
        code: 'export { Heartbeat, HEARTBEAT_AUDIT_EVENTS } from "../heartbeat/index.js";',
        filename: 'src/core/runtime/index.ts',
      },
      // unrelated import
      {
        code: 'import { foo } from "./other.js";',
        filename: 'src/core/runtime/runtime.ts',
      },
      // unrelated member access
      {
        code: 'const x = OTHER_EVENTS.X;',
        filename: 'src/core/runtime/runtime.ts',
      },
      // .d.ts skip
      {
        code: 'const x = "claw_crashed";',
        filename: 'src/core/runtime/types.d.ts'
      },
    ],
    invalid: [
      // claw_crashed literal
      {
        code: 'const x = "claw_crashed";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'clawCrashedLiteral' }],
      },
      // HEARTBEAT.md literal
      {
        code: 'const p = "HEARTBEAT.md";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'heartbeatMdPath' }],
      },
      // HEARTBEAT_AUDIT_EVENTS import
      {
        code: 'import { HEARTBEAT_AUDIT_EVENTS } from "../heartbeat/audit-events.js";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'heartbeatAuditEventsImportOrUse' }],
      },
      // HEARTBEAT_AUDIT_EVENTS member access
      {
        code: 'const e = HEARTBEAT_AUDIT_EVENTS.HEARTBEAT_FAILED;',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'heartbeatAuditEventsImportOrUse' }],
      },
      // mixed: import + use → 2 errors
      {
        code: 'import { HEARTBEAT_AUDIT_EVENTS } from "../heartbeat/audit-events.js"; const e = HEARTBEAT_AUDIT_EVENTS.X;',
        filename: 'src/core/runtime/runtime.ts',
        errors: [
          { messageId: 'heartbeatAuditEventsImportOrUse' },
          { messageId: 'heartbeatAuditEventsImportOrUse' },
        ],
      },
    ],
  });

});
