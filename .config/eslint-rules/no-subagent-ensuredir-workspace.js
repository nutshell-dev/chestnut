/**
 * Custom ESLint rule: no-subagent-ensuredir-workspace
 *
 * 应然 (phase 805 + phase 1371 sub-6): subagent (src/core/subagent/) 不 create
 * workspace dir。runSubagent does NOT create subagent workspace dir、装配端
 * (caller) own workspace creation。
 *
 * scope: src/core/subagent/ outside .d.ts
 *
 * 匹配的 pattern:
 *   CallExpression where callee Identifier name matches
 *   /^(ensureDir|mkdir|mkdirSync)$/ AND first argument source text contains
 *   /workspace|CLAWSPACE|workspaceDir/i
 *
 * phase 402: 29th src ESLint rule
 */

const CALL_NAMES = new Set(['ensureDir', 'mkdir', 'mkdirSync']);
const WORKSPACE_RE = /workspace|CLAWSPACE|workspaceDir/i;

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/core/subagent/ does not create workspace dir (phase 805 + 1371 sub-6)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      subagentEnsureDirWorkspace:
        'Subagent must not create workspace dir in `{{file}}`. phase 805 assumption: runSubagent does NOT create subagent workspace dir. Caller (装配端) is responsible for workspace creation.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/core/subagent/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = basenameOf(filename);
    const sourceCode = context.sourceCode || context.getSourceCode();

    return {
      CallExpression(node) {
        const callee = node.callee;
        let calleeName = null;
        if (callee.type === 'Identifier') {
          calleeName = callee.name;
        } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
          calleeName = callee.property.name;
        }
        if (!calleeName || !CALL_NAMES.has(calleeName)) return;
        if (node.arguments.length === 0) return;
        const arg0Text = sourceCode.getText(node.arguments[0]);
        if (!WORKSPACE_RE.test(arg0Text)) return;
        context.report({
          node,
          messageId: 'subagentEnsureDirWorkspace',
          data: { file: base },
        });
      },
    };
  },
};
