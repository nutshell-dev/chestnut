/**
 * Custom ESLint rule: no-runtime-current-state-getter
 *
 * 应然 (phase 146): Runtime mirror state getter 已删、caller-snapshot 应直接 read
 * 真 owner (Prompt + ToolRegistry + DialogStore)、不经 Runtime mirror。
 *
 * Forward-defending: prevent re-introduction of `getCurrentSystemPrompt` /
 * `getCurrentTools` / `getCurrentMessages` identifier in src/.
 *
 * scope: src/ (.ts、非 .d.ts)
 *
 * Identifier visitor fires on all forms: method definition, call, property
 * access, import. No allowlist (phase 146 close 后预期 0 src 引用)。
 *
 * phase 353: 20th src ESLint rule、共享 phase 309 ESLint infra
 */

const FORBIDDEN = new Set([
  'getCurrentSystemPrompt',
  'getCurrentTools',
  'getCurrentMessages',
]);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ forbids Runtime mirror state getter identifier (phase 146)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      mirrorGetterReintroduced:
        'Runtime mirror state getter `{{name}}` re-introduced in `{{file}}`. caller-snapshot must read true owner (Prompt + ToolRegistry + DialogStore), not Runtime mirror (phase 146 close).',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = (() => {
      const idx = filename.lastIndexOf('/');
      return idx === -1 ? filename : filename.slice(idx + 1);
    })();

    return {
      Identifier(node) {
        if (!FORBIDDEN.has(node.name)) return;
        context.report({
          node,
          messageId: 'mirrorGetterReintroduced',
          data: { name: node.name, file: base },
        });
      },
    };
  },
};
