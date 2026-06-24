import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noClawsEnumerationFanout from '../../../.config/eslint-rules/no-claws-enumeration-fanout.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-claws-enumeration-fanout (phase 357)', () => {
  ruleTester.run('no-claws-enumeration-fanout', noClawsEnumerationFanout, {
    valid: [
      // out of src/
      {
        code: 'fs.listSync(clawsDir, { includeDirs: true });',
        filename: 'tests/foo.test.ts',
      },
      // allowlist: claw-paths.ts (phase 705 backward-compat)
      {
        code: 'fs.listSync(clawsDir, { includeDirs: true });',
        filename: 'src/foundation/claw-paths.ts',
      },
      // allowlist: claw-instance-paths.ts (phase 707 canonical owner)
      {
        code: 'fs.listSync(clawsDir, { includeDirs: true });',
        filename: 'src/core/claw-topology/claw-instance-paths.ts',
      },
      // listSync over non-claws path
      {
        code: 'fs.listSync(tasksDir, { includeDirs: true });',
        filename: 'src/core/runtime/runtime.ts',
      },
      // listSync over claws but no includeDirs
      {
        code: 'fs.listSync(clawsDir, { recursive: true });',
        filename: 'src/core/runtime/runtime.ts',
      },
      // listSync over claws with includeDirs: false
      {
        code: 'fs.listSync(clawsDir, { includeDirs: false });',
        filename: 'src/core/runtime/runtime.ts',
      },
      // unrelated method
      {
        code: 'fs.readSync(clawsDir, { includeDirs: true });',
        filename: 'src/core/runtime/runtime.ts',
      },
      // single arg
      {
        code: 'fs.listSync(clawsDir);',
        filename: 'src/core/runtime/runtime.ts',
      },
      // all-caps CLAWS_DIR doesn't match grep contract `[Cc]laws` (mirror original)
      {
        code: 'fs.listSync(CLAWS_DIR, { includeDirs: true });',
        filename: 'src/core/runtime/runtime.ts',
      },
    ],
    invalid: [
      // direct fs.listSync(clawsDir, {includeDirs: true})
      {
        code: 'fs.listSync(clawsDir, { includeDirs: true });',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'clawsEnumerationFanout' }],
      },
      // non-fs object also flagged (AST stronger than grep)
      {
        code: 'this.fs.listSync(clawsDir, { includeDirs: true });',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'clawsEnumerationFanout' }],
      },
      // computed arg containing claws
      {
        code: 'fs.listSync(path.join(root, "claws"), { includeDirs: true });',
        filename: 'src/cli/commands/foo.ts',
        errors: [{ messageId: 'clawsEnumerationFanout' }],
      },
      // string-key `includeDirs`
      {
        code: 'fs.listSync(clawsDir, { "includeDirs": true });',
        filename: 'src/core/runtime/runtime.ts',
        errors: [{ messageId: 'clawsEnumerationFanout' }],
      },
    ],
  });

  it('rule loaded', () => {});
});
