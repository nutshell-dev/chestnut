import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import noClawdirPathAntiPattern from '../../../.config/eslint-rules/no-clawdir-path-anti-pattern.js';

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
});

describe('eslint custom rule: no-clawdir-path-anti-pattern (phase 327)', () => {
  ruleTester.run('no-clawdir-path-anti-pattern', noClawdirPathAntiPattern, {
    valid: [
      // (1) correct pattern: path.join(ctx.chestnutRoot, CLAWS_DIR)
      'path.join(ctx.chestnutRoot, CLAWS_DIR);',
      // (2) dirname on non-claw arg
      'path.dirname(somePath);',
      // (3) double-up makeChestnutRoot
      'makeChestnutRoot(path.join(clawDir, "..", ".."));',
      // (3) makeChestnutRoot from getChestnutRoot
      'makeChestnutRoot(getChestnutRoot());',
      // (2) dirname with Motion-only exemption (same line comment)
      'const root = path.dirname(clawDir); // Motion-only callsite',
      // (3) single-up inside resolveChestnutRoot motion branch is intentional
      `function resolveChestnutRoot(clawDir, isMotion) {
        return isMotion
          ? makeChestnutRoot(path.join(clawDir, ".."))
          : makeChestnutRoot(path.join(clawDir, "..", ".."));
      }`,
      // (1) resolve with non-CLAWS_DIR
      'path.resolve(clawDir, "..", "other");',
    ],
    invalid: [
      // (1) resolve(clawDir, '..', CLAWS_DIR)
      {
        code: 'path.resolve(clawDir, "..", CLAWS_DIR);',
        errors: [{ messageId: 'patternResolveParentClaws' }],
      },
      // (1) resolve(ctx.clawDir, '..', CLAWS_DIR)
      {
        code: 'nodePath.resolve(ctx.clawDir, "..", CLAWS_DIR);',
        errors: [{ messageId: 'patternResolveParentClaws' }],
      },
      // (2) path.dirname(clawDir) no Motion-only
      {
        code: 'path.dirname(clawDir);',
        errors: [{ messageId: 'patternDirnameClawdir' }],
      },
      // (2) path.dirname(agentDir)
      {
        code: 'path.dirname(agentDir);',
        errors: [{ messageId: 'patternDirnameClawdir' }],
      },
      // (3) makeChestnutRoot(path.join(clawDir, '..')) single-up
      {
        code: 'makeChestnutRoot(path.join(clawDir, ".."));',
        errors: [{ messageId: 'patternSingleUpMakeRoot' }],
      },
      // (3) makeChestnutRoot(path.join(agentDir, '..')) single-up
      {
        code: 'makeChestnutRoot(path.join(agentDir, ".."));',
        errors: [{ messageId: 'patternSingleUpMakeRoot' }],
      },
    ],
  });

});
