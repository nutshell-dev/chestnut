/**
 * Custom ESLint rule: no-reassign-handle-context-exceeded
 *
 * 应然 (phase 224 dialog persist invariant): caller 用
 * `messages = handleContextExceeded(...)` 切断 persist messages 引用、
 * 应改为 `const callView = handleContextExceeded(...)` + 用 callView.messages
 * 构造 LLMCallOptions、append 走 caller 原 messages 引用。
 *
 * scope: src/ outside .d.ts and outside allowlist
 *
 * 匹配的 pattern:
 *   1. AssignmentExpression: left = Identifier|MemberExpression where
 *      identifier name === 'messages'; right = CallExpression with callee
 *      Identifier name === 'handleContextExceeded'
 *   2. VariableDeclarator: id.name === 'messages'; init = CallExpression
 *      with callee.name === 'handleContextExceeded'
 *
 * Allowlist (1 file): `core/l4_context_manager/exceeded.ts` (helper 自身 return / 类型字面)
 *
 * phase 399: 27th src ESLint rule
 */

const ALLOWLIST_SUFFIXES = [
  'src/core/l4_context_manager/exceeded.ts',
];

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

function isAllowlisted(filename) {
  return ALLOWLIST_SUFFIXES.some((s) => filename.endsWith(s));
}

function isHandleContextExceededCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  if (node.callee.type !== 'Identifier') return false;
  return node.callee.name === 'handleContextExceeded';
}

function leftIsMessages(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === 'messages';
  if (node.type === 'MemberExpression') {
    if (node.property.type === 'Identifier') return node.property.name === 'messages';
    if (node.property.type === 'Literal') return node.property.value === 'messages';
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ forbids `messages = handleContextExceeded(...)` (phase 224: caller persist messages reference)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      messagesReassignFromHandleContextExceeded:
        'Caller assigns `messages = handleContextExceeded(...)` in `{{file}}`. 切断 persist messages 引用、应改为 `const callView = handleContextExceeded(...)` + 用 callView.messages 构造 LLMCallOptions、append 走 caller 原 messages 引用 (phase 224).',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};
    if (isAllowlisted(filename)) return {};

    const base = basenameOf(filename);

    function report(node) {
      context.report({
        node,
        messageId: 'messagesReassignFromHandleContextExceeded',
        data: { file: base },
      });
    }

    return {
      AssignmentExpression(node) {
        if (!leftIsMessages(node.left)) return;
        if (!isHandleContextExceededCall(node.right)) return;
        report(node);
      },
      VariableDeclarator(node) {
        if (!node.id) return;
        if (node.id.type !== 'Identifier' || node.id.name !== 'messages') return;
        if (!isHandleContextExceededCall(node.init)) return;
        report(node);
      },
    };
  },
};
