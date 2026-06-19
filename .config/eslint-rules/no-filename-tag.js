/**
 * Custom ESLint rule: no-filename-tag
 *
 * 应然 (phase 1183 r129 D fork F.10): `filenameTag` dead field cluster delete
 * cascade 已清空 src/。Forward-defend re-introduction (字面 / identifier /
 * comment / jsdoc 任意形态).
 *
 * scope: src/ outside .d.ts
 *
 * 匹配的 pattern:
 *   Program + sourceCode.getText() + regex /\bfilenameTag\b/
 *
 * No allowlist (phase 1183 close 后 0 hit、预期保持).
 *
 * phase 382: 25th src ESLint rule
 * source-text regex family 与 phase 349 + phase 377 Step A 同模板
 */

// `.test()` is stateful with /g flag (advances lastIndex); drop /g since we only need presence check.
const BAN_PATTERN = /\bfilenameTag\b/;

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
        'src/ forbids `filenameTag` dead field (phase 1183 r129 D fork F.10 delete cascade)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      filenameTagReintroduced:
        '`filenameTag` dead field re-introduced in `{{file}}`. phase 1183 r129 D fork F.10 delete cascade 已清。Forward-defend reintroduction.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = basenameOf(filename);
    const sourceCode = context.sourceCode || context.getSourceCode();

    return {
      Program(node) {
        const text = sourceCode.getText();
        if (!BAN_PATTERN.test(text)) return;
        context.report({
          node,
          messageId: 'filenameTagReintroduced',
          data: { file: base },
        });
      },
    };
  },
};
