/**
 * Custom ESLint rule: no-chat-method
 *
 * 应然 (phase 151): Runtime.chat() 已删（src 0 caller、tests refactor 用
 * processWithMessage）。forward-defend 重引此 method。
 *
 * scope: src/ (.ts、非 .d.ts)
 *
 * 匹配的 pattern:
 *   1. CallExpression where callee.property.name === 'chat' — `.chat(...)` invocation
 *   2. MethodDefinition where key.name === 'chat' — class method 定义
 *   3. Property where key.name === 'chat' AND value 是 Function/Arrow expression — object method
 *
 * Line-level exemption (vitest contract mirror):
 *   - line text contains 'LLM' | 'claude' | 'anthropic' | 'messages' (LLM provider chat API)
 *   - line text contains '//' (comment lines / vitest test filter mirror)
 *
 * phase 377 Step C: 23rd src ESLint rule
 * Line-level exemption family 与 phase 340 `no-console-in-business-path` 同
 */

const EXEMPTION_TOKENS = ['LLM', 'claude', 'anthropic', 'messages'];

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

function lineExempt(lineText) {
  if (lineText.includes('//')) return true;
  return EXEMPTION_TOKENS.some((t) => lineText.includes(t));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ forbids `.chat()` method (phase 151 删 Runtime.chat() / 使用 processWithMessage)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      chatMethodReintroduced:
        '`chat()` method re-introduced in `{{file}}`. phase 151 删 Runtime.chat() / 使用 processWithMessage(). Exempted if line contains LLM/claude/anthropic/messages (LLM provider chat API).',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = basenameOf(filename);
    const sourceCode = context.sourceCode || context.getSourceCode();
    const lines = sourceCode.lines;

    function checkAt(node) {
      const lineIdx = node.loc.start.line - 1;
      const lineText = lines[lineIdx] || '';
      if (lineExempt(lineText)) return;
      context.report({
        node,
        messageId: 'chatMethodReintroduced',
        data: { file: base },
      });
    }

    return {
      // .chat(...) call
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier') return;
        if (callee.property.name !== 'chat') return;
        checkAt(node);
      },
      // class { chat() {} } / class { async chat() {} }
      MethodDefinition(node) {
        if (node.key.type !== 'Identifier') return;
        if (node.key.name !== 'chat') return;
        checkAt(node);
      },
      // { chat: function() {} } / { chat() {} } / { chat: () => {} }
      Property(node) {
        if (node.key.type !== 'Identifier') return;
        if (node.key.name !== 'chat') return;
        const v = node.value;
        if (v.type !== 'FunctionExpression' && v.type !== 'ArrowFunctionExpression') return;
        checkAt(node);
      },
    };
  },
};
