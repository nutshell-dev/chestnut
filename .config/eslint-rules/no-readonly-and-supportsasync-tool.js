/**
 * Custom ESLint rule: no-readonly-and-supportsasync-tool
 *
 * 应然 (P1.12 / β reframe): Tool 定义不应同时 `readonly: true` AND
 * `supportsAsync: true` (互斥)。
 *   - readonly: true → sync read-only tool
 *   - supportsAsync: true → stateful async tool
 *
 * scope: src/ outside .d.ts and outside 2-file allowlist
 *
 * 匹配的 pattern:
 *   ObjectExpression { properties contain
 *     - Property { key.name === 'readonly', value === true (Literal) }
 *     - Property { key.name === 'supportsAsync', value === true (Literal) }
 *   }
 *
 * Allowlist (2 file, P1.12 baseline tech debt):
 *   - foundation/file-tool/search.ts
 *   - core/memory/tools/memory_search.ts
 *
 * phase 401: 28th src ESLint rule
 */

const ALLOWLIST_SUFFIXES = [
  'src/foundation/file-tool/search.ts',
  'src/core/memory/tools/memory_search.ts',
];

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

function isAllowlisted(filename) {
  return ALLOWLIST_SUFFIXES.some((s) => filename.endsWith(s));
}

function hasPropEqTrue(node, propName) {
  if (!node || node.type !== 'ObjectExpression') return false;
  for (const prop of node.properties) {
    if (prop.type !== 'Property') continue;
    const key = prop.key;
    const keyName =
      key.type === 'Identifier' ? key.name :
      key.type === 'Literal' ? String(key.value) :
      null;
    if (keyName !== propName) continue;
    const v = prop.value;
    if (v.type === 'Literal' && v.value === true) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ tool definition forbids both `readonly: true` and `supportsAsync: true` (P1.12 mutual exclusion)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      readonlyAndSupportsAsync:
        'Tool in `{{file}}` has both `readonly: true` and `supportsAsync: true` (P1.12 mutual exclusion). Choose one: readonly for sync read-only tools, supportsAsync for stateful async tools.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};
    if (isAllowlisted(filename)) return {};

    const base = basenameOf(filename);

    return {
      ObjectExpression(node) {
        if (!hasPropEqTrue(node, 'readonly')) return;
        if (!hasPropEqTrue(node, 'supportsAsync')) return;
        context.report({
          node,
          messageId: 'readonlyAndSupportsAsync',
          data: { file: base },
        });
      },
    };
  },
};
