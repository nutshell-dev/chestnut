/**
 * Custom ESLint rule: no-chestnut-dir-naming
 *
 * 应然 (phase 1376 sub-4): M#1 同型职责不分双名、chestnutRoot/chestnutDir
 * 同义统一为 chestnutRoot。`chestnutDir` 标识符 forbidden in src/.
 *
 * scope: src/ outside .d.ts
 *
 * 匹配的 pattern:
 *   Identifier { name === 'chestnutDir' } — 任何形态 (variable/property/method def/import)
 *
 * No allowlist (phase 1376 close 后 src/ 0 hit、预期保持).
 *
 * phase 378: 24th src ESLint rule
 * 模板与 phase 353 `no-runtime-current-state-getter` 完全一致 (差异：1 banned name)
 */

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
        'src/ forbids `chestnutDir` identifier (M#1 同型职责不分双名, phase 1376 sub-4 统一为 chestnutRoot)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      chestnutDirReintroduced:
        '`chestnutDir` identifier re-introduced in `{{file}}`. M#1 同型职责不分双名: use `chestnutRoot` (phase 1376 sub-4 统一).',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = basenameOf(filename);

    return {
      Identifier(node) {
        if (node.name !== 'chestnutDir') return;
        context.report({
          node,
          messageId: 'chestnutDirReintroduced',
          data: { file: base },
        });
      },
    };
  },
};
