import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noMotionLiteralInSrc from '../../../.config/eslint-rules/no-motion-literal-in-src.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-motion-literal-in-src (phase 336)', () => {
  ruleTester.run('no-motion-literal-in-src', noMotionLiteralInSrc, {
    valid: [
      // out of scope (src/cli/ but not commands/)
      { code: 'const x = "motion";', filename: 'src/cli/index.ts' },
      { code: 'const x = "motion";', filename: 'tests/foo.test.ts' },
      // in scope but uses MOTION_CLAW_ID const
      { code: 'const x = MOTION_CLAW_ID;', filename: 'src/cli/commands/claw-steps.ts' },
      // allowlist: fs path segment .chestnut/motion
      { code: 'const p = ".chestnut/motion";', filename: 'src/foundation/skill-system/skill.ts' },
      // allowlist: path.join with .chestnut + motion
      { code: 'const p = path.join(root, ".chestnut", "motion");', filename: 'src/core/runtime/runtime.ts' },
      // allowlist: templates/motion
      { code: 'const p = "templates/motion";', filename: 'src/cli/commands/init.ts' },
      // allowlist: path.join with templates + motion
      { code: 'const p = path.join(root, "templates", "motion");', filename: 'src/cli/commands/init.ts' },
      // allowlist: bucket B getNamedSubrootDir
      { code: 'const d = getNamedSubrootDir("motion");', filename: 'src/foundation/fs/dirs.ts' },
      // allowlist: type literal union (same line) — JS comment workaround for espree (no TS)
      { code: '/* type Role = "motion" | "claw" */', filename: 'src/foundation/tools/types.ts' },
      // allowlist: line comment 如 'motion'
      { code: '// 如 \'motion\' (example label)', filename: 'src/core/foo.ts' },
    ],
    invalid: [
      // plain 'motion' Literal in src/core
      {
        code: 'const x = "motion";',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'motionLiteral' }],
      },
      // 'motion' in src/foundation
      {
        code: 'const x = "motion";',
        filename: 'src/foundation/audit/events.ts',
        errors: [{ messageId: 'motionLiteral' }],
      },
      // 'motion' in src/daemon
      {
        code: 'function f() { return "motion"; }',
        filename: 'src/daemon/daemon.ts',
        errors: [{ messageId: 'motionLiteral' }],
      },
      // template literal motion
      {
        code: 'const x = `motion`;',
        filename: 'src/watchdog/watchdog.ts',
        errors: [{ messageId: 'motionLiteral' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
