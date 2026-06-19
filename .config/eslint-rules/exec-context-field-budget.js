/**
 * Custom ESLint rule: exec-context-field-budget
 *
 * 应然 (phase 808 升档条件 a + phase 968 mechanical enforcement):
 * `interface ExecContext` 直接 body members 数量 ≤ 35。
 * 超过则需升档评估 (dual-write fields cluster / single-reader concentration)。
 *
 * scope: src/foundation/tools/types.ts only
 *
 * 匹配的 pattern:
 *   TSInterfaceDeclaration { id.name === 'ExecContext' } where
 *   body.body.length > 35
 *
 * 注 phase 61 后 ExecContext body 可能为空 (member 拆迁出去 + extends 多 interface)、
 * 本 rule 仅守 inline member 不再爆增。extends 继承的 member 不计入。
 *
 * RuleTester 需 @typescript-eslint/parser (TSInterfaceDeclaration 非 espree 标准)。
 *
 * phase 404: 30th src ESLint rule
 */

const TARGET_SUFFIX = 'src/foundation/tools/types.ts';
const TARGET_INTERFACE = 'ExecContext';
const MAX_MEMBERS = 35;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'ExecContext interface members count must be ≤ 35 (phase 808 升档条件 a)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      execContextOverBudget:
        'ExecContext interface has {{count}} members (> 35, phase 808 升档条件 a). Adding a new field requires升档评估: dual-write fields cluster / single-reader concentration.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.endsWith(TARGET_SUFFIX)) return {};

    return {
      TSInterfaceDeclaration(node) {
        if (!node.id || node.id.name !== TARGET_INTERFACE) return;
        if (!node.body || !Array.isArray(node.body.body)) return;
        const count = node.body.body.length;
        if (count <= MAX_MEMBERS) return;
        context.report({
          node,
          messageId: 'execContextOverBudget',
          data: { count: String(count) },
        });
      },
    };
  },
};
