/**
 * Custom ESLint rule: audit-cap-const-scope
 *
 * 应然 (phase 213 Step D): AUDIT_PREVIEW_LEN + AUDIT_MESSAGE_MAX_CHARS const
 * must only live inside foundation/audit/.
 *
 * - src/ outside foundation/audit/: 不持 Identifier
 * - foundation/audit/defaults.ts (positive presence verified by RuleTester via
 *   separate unit test, not by this rule).
 *
 * phase 330 cluster mixed-case-T3.5 close 替代 phase 1395/213 grep ratchet (partial)
 * phase 568 cleanup: 删 isConstantsFile dead code (foundation/constants.ts 从未存在、
 * src/constants.ts phase 520 删；本 rule 逻辑等价、单一 outside-audit-dir gate 即足).
 * 共享 phase 309 ESLint infra
 */

const BANNED = new Set(['AUDIT_PREVIEW_LEN', 'AUDIT_MESSAGE_MAX_CHARS']);

function isInAuditDir(filename) {
  return filename.includes('foundation/audit/');
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'AUDIT_PREVIEW_LEN / AUDIT_MESSAGE_MAX_CHARS may only live inside foundation/audit/ (phase 213 Step D)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      auditCapOutsideScope:
        'Audit cap constant "{{name}}" referenced outside foundation/audit/. It must only live in foundation/audit/defaults.ts.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    // skip files inside foundation/audit/
    if (isInAuditDir(filename)) return {};

    return {
      Identifier(node) {
        if (!BANNED.has(node.name)) return;
        context.report({
          node,
          messageId: 'auditCapOutsideScope',
          data: { name: node.name },
        });
      },
    };
  },
};
