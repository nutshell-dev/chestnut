/**
 * Custom ESLint rule: no-console-in-business-path
 *
 * 应然 (phase 1179): business path 不直 console.(log|error|warn|debug)、
 * 必走 audit 单源 (DP-2 错误暴露而非吞没 + audit-of-audit border)。
 *
 * scope: src/ outside allowlist
 *
 * Allowlist (6 categories):
 *   - cli/** + watchdog/** (CLI user-face / structural boundaries)
 *   - daemon-entry.ts + daemon-handlers.ts + watchdog-entry.ts (process-level uncaught handlers)
 *   - foundation/audit/** (audit recursion border)
 *   - assembly/llm-audit-sink.ts (audit-of-audit fallback)
 *
 * Line-level exemption:
 *   - `// console: <reason>` same-line comment
 *   - line contains `[AUDIT CRITICAL]` (audit recursion border)
 *
 * phase 340 framing 锚 N=17 严守: src-targeting → ESLint custom rule
 * 共享 phase 309 ESLint infra (17th rule)
 */

const ALLOWLIST_PREFIXES = [
  'src/cli/',
  'src/watchdog/',
  'src/foundation/audit/',
];

const ALLOWLIST_FILES = [
  'src/daemon-entry.ts',
  'src/daemon-handlers.ts',
  'src/watchdog-entry.ts',
  'src/assembly/llm-audit-sink.ts',
];

function isAllowlisted(filename) {
  for (const p of ALLOWLIST_PREFIXES) {
    if (filename.includes(p)) return true;
  }
  for (const f of ALLOWLIST_FILES) {
    if (filename.endsWith(f)) return true;
  }
  return false;
}

const CONSOLE_METHODS = new Set(['log', 'error', 'warn', 'debug']);
const EXEMPTION_REGEX = /\/\/\s*console:\s*.+/;
const AUDIT_CRITICAL_MARKER = '[AUDIT CRITICAL]';

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'business path no console.(log|error|warn|debug) (phase 1179): use audit single source',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      consoleInBusinessPath:
        'console.{{method}}() in business path. Use audit single source (DP-2). To allow: add `// console: <reason>` exemption comment on same line.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (isAllowlisted(filename)) return {};

    const sourceCode = context.sourceCode || context.getSourceCode();
    const lines = sourceCode.lines;

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.object.type !== 'Identifier' || callee.object.name !== 'console') return;
        if (callee.property.type !== 'Identifier') return;
        if (!CONSOLE_METHODS.has(callee.property.name)) return;

        const lineIdx = node.loc.start.line - 1;
        const lineText = lines[lineIdx] || '';

        // exemption: same-line `// console: <reason>` comment
        if (EXEMPTION_REGEX.test(lineText)) return;
        // special: audit recursion border `[AUDIT CRITICAL]`
        if (lineText.includes(AUDIT_CRITICAL_MARKER)) return;

        context.report({
          node,
          messageId: 'consoleInBusinessPath',
          data: { method: callee.property.name },
        });
      },
    };
  },
};
