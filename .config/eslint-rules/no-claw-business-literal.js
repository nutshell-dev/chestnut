/**
 * Custom ESLint rule: no-claw-business-literal
 *
 * 应然 (phase 65 + l1_filesystem.md §1.不做 + architecture.md L13):
 * src/foundation/fs/ 不持 chestnut 业务概念。L1 = OS / 网络 / 外部 SDK 中性接口、
 * 不 own agent / claw / motion 业务概念。
 *
 * scope: src/foundation/fs/ only
 *
 * banList (case-insensitive 整词):
 *   - clawspace
 *   - claw root (with whitespace)
 *   - clawsDir
 *   - clawsId
 *   - motion
 *
 * 不 grep 单字 `claw` 防 false positive（如 jsdoc "caller claw"）。
 *
 * Why Program + source-text regex visitor:
 *   原 vitest test grep raw source text、catches Literal + Identifier +
 *   comment + jsdoc 所有形态。多个 AST visitor 合代价 > Program 整 file
 *   source-text 跑 regex 单 visitor。与 phase 349 `no-silent-x-without-allowed-pattern`
 *   source-text regex family 同模板。
 *
 * 现状 baseline: foundation/fs/ 0 hit (phase 65 cluster close 后保持)。
 * Future drift via this rule + Defense-in-depth 与 `foundation-no-business-role-literal`
 * (后者守 BUSINESS_ROLES exact Literal、本 rule 守 banList substring+identifier+comment) 互补。
 */

const BAN_LIST = /\b(clawspace|claw\s+root|clawsDir|clawsId|motion)\b/gi;

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
        'src/foundation/fs/ forbids chestnut business token (clawspace / claws / motion). L1 must stay neutral.',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      businessTokenLeak:
        'foundation/fs/ business token leak in `{{file}}`: matched `{{matches}}`. L1 = OS / 网络 / 外部 SDK neutral interface, must not hold chestnut business concept (clawspace / claws / motion). See l1_filesystem.md §1.不做.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/foundation/fs/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = basenameOf(filename);
    const sourceCode = context.sourceCode || context.getSourceCode();

    return {
      Program(node) {
        const text = sourceCode.getText();
        const matches = text.match(BAN_LIST);
        if (!matches || matches.length === 0) return;
        const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
        context.report({
          node,
          messageId: 'businessTokenLeak',
          data: { file: base, matches: unique.join(', ') },
        });
      },
    };
  },
};
