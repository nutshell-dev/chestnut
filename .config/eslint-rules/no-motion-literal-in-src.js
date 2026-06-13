/**
 * Custom ESLint rule: no-motion-literal-in-src
 *
 * 应然 (M#5 + phase 1265 r135 C fork 2026-05-25): src/ 5 dir 不持 'motion' /
 * "motion" Literal。caller 必经 MOTION_CLAW_ID const (src/constants.ts) SoT。
 *
 * scope: src/cli/commands + src/daemon + src/watchdog + src/foundation + src/core
 *
 * Line-level allowlist (caller 行内含此模式 → 豁免):
 *   - fs path: '.chestnut/motion' / 'templates/motion'
 *   - path.join with 'motion' segment
 *   - getNamedSubrootDir('motion') bucket B
 *   - type literal union: 'motion' | 'claw'
 *   - JSDoc / line comment
 *
 * phase 336 framing 锚 N=17 严守: src-targeting → ESLint custom rule
 * 共享 phase 309 ESLint infra (16th rule)
 */

const SCOPE_DIRS = [
  'src/cli/commands/',
  'src/daemon/',
  'src/watchdog/',
  'src/foundation/',
  'src/core/',
];

function inScope(filename) {
  return SCOPE_DIRS.some(d => filename.includes(d));
}

const ALLOWLIST_LINE_PATTERNS = [
  /\.chestnut\/motion/,                       // .chestnut/motion path segment
  /path\.join.*\.chestnut.*['"]motion['"]/,   // path.join(..., '.chestnut', 'motion')
  /templates\/motion/,                         // templates/motion path
  /path\.join.*templates.*['"]motion['"]/,    // path.join(..., 'templates', 'motion')
  /getNamedSubrootDir\(['"]motion['"]\)/,     // bucket B fs subdir
  /path\.join.*['"]motion['"]/,                // bucket B other path.join forms
  /['"]motion['"]\s*\|\s*['"]claw['"]/,       // bucket C type literal union (TS discriminated)
  /\/\/.*['"]motion['"]/,                      // bucket E line comment
  /\*.*['"]motion['"]/,                        // bucket E JSDoc + line comment
  /\/\/.*如 ['"]motion['"]/,                   // line comment 如 'motion'
];

function isAllowedLine(line) {
  return ALLOWLIST_LINE_PATTERNS.some(p => p.test(line));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ 5 dir no quoted motion literal (M#5 + phase 1265 r135 C fork): use MOTION_CLAW_ID const',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      motionLiteral:
        '"motion" Literal detected in src/. Use MOTION_CLAW_ID const from src/constants.ts (M#5, phase 1265). Allowlist: fs path segments / type union / comments.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!inScope(filename)) return {};

    const sourceCode = context.sourceCode || context.getSourceCode();
    const lines = sourceCode.lines;

    function checkNode(node, value) {
      if (value !== 'motion') return;
      const lineIdx = node.loc.start.line - 1;
      const lineText = lines[lineIdx] || '';
      if (isAllowedLine(lineText)) return;
      context.report({ node, messageId: 'motionLiteral' });
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') checkNode(node, node.value);
      },
      TemplateElement(node) {
        const v = node.value && node.value.cooked;
        if (typeof v === 'string') checkNode(node, v);
      },
    };
  },
};
