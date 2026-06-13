/**
 * Custom ESLint rule: no-direct-new-nodefilesystem
 *
 * 应然 (M#3 资源唯一归属 + M#7 模块边界稳定 + phase 1283):
 * `new NodeFileSystem` 只在 bootstrap site 构造、其他模块通过 fsFactory 注入。
 *
 * scope: src/ outside allowlist
 *
 * 匹配的 pattern:
 *   NewExpression { callee: Identifier { name: 'NodeFileSystem' } }
 *
 * Allowlist (prefix match, 6 sites):
 *   - src/assembly/assemble.ts
 *   - src/assembly/core-infrastructure.ts
 *   - src/cli/index.ts
 *   - src/daemon-entry.ts
 *   - src/watchdog-entry.ts
 *   - src/foundation/fs/ (NodeFileSystem 自身实现 dir)
 *
 * phase 359: 22nd src ESLint rule
 */

const ALLOWLIST_PREFIXES = [
  'src/assembly/assemble.ts',
  'src/assembly/core-infrastructure.ts',
  'src/cli/index.ts',
  'src/daemon-entry.ts',
  'src/watchdog-entry.ts',
  'src/foundation/fs/',
];

function isAllowlisted(filename) {
  for (const p of ALLOWLIST_PREFIXES) {
    if (filename.includes(p)) return true;
  }
  return false;
}

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
        'src/ forbids direct `new NodeFileSystem` outside bootstrap sites (M#3+M#7, phase 1283)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      directNewNodeFileSystem:
        'Direct `new NodeFileSystem` in `{{file}}` violates M#3+M#7 (FileSystem injection single path). Inject fsFactory instead. Only bootstrap sites may construct directly.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};
    if (isAllowlisted(filename)) return {};

    const base = basenameOf(filename);

    return {
      NewExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        if (node.callee.name !== 'NodeFileSystem') return;
        context.report({
          node,
          messageId: 'directNewNodeFileSystem',
          data: { file: base },
        });
      },
    };
  },
};
