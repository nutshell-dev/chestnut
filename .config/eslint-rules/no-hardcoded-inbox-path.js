/**
 * Custom ESLint rule: no-hardcoded-inbox-path
 *
 * 应然：Messaging 统一拥有 inbox/outbox 叶路径，其他模块只能通过其能力访问。
 *
 * Messaging owns every inbox/outbox leaf. Other production modules pass a claw
 * root or targetClawId to root-bound Messaging capabilities.
 */

const LEAF_EXPORTS = new Set([
  'INBOX_PENDING_DIR', 'INBOX_INFLIGHT_DIR', 'INBOX_MISROUTED_DIR',
  'INBOX_DONE_DIR', 'INBOX_FAILED_DIR', 'OUTBOX_PENDING_DIR',
  'OUTBOX_DONE_DIR', 'OUTBOX_FAILED_DIR', 'OUTBOX_PROCESSING_DIR',
  'makeInboxPath', 'makeOutboxPath', 'resolveDlqDir',
]);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Messaging leaf paths must be derived by Messaging from a claw root',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      hardcodedInboxPath: 'Do not construct Messaging leaf paths outside foundation/messaging; pass a claw root instead.',
      messagingLeafEscape: 'Do not import or call Messaging leaf constructors/constants outside foundation/messaging.',
    },
  },

  create(context) {
    if (context.filename.includes('foundation/messaging/')) return {};

    return {
      ImportDeclaration(node) {
        if (!node.source.value.includes('/messaging/')) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && LEAF_EXPORTS.has(specifier.imported.name)) {
            context.report({ node: specifier, messageId: 'messagingLeafEscape' });
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'Identifier' && ['makeInboxPath', 'makeOutboxPath', 'resolveDlqDir'].includes(callee.name)) {
          context.report({ node, messageId: 'messagingLeafEscape' });
          return;
        }
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' && callee.property.name === '__internal_create'
        ) {
          context.report({ node, messageId: 'messagingLeafEscape' });
          return;
        }
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' || callee.object.name !== 'path' ||
          callee.property.type !== 'Identifier' || callee.property.name !== 'join'
        ) return;

        const literals = node.arguments
          .filter(a => a.type === 'Literal' && typeof a.value === 'string')
          .map(a => a.value);
        const joined = literals.join('/');
        if (/(?:^|\/)(?:inbox|outbox)\/(?:pending|inflight|misrouted|done|failed|processing|dead-letter)(?:\/|$)/.test(joined)) {
          context.report({ node, messageId: 'hardcodedInboxPath' });
        }
      },
    };
  },
};
