/**
 * Custom ESLint rule: no-bare-tempdir-in-tests
 *
 * 应然：tests/ 下所有临时目录创建都应经过 tests/utils/temp.ts 的统一封装，
 * 使 TMPDIR 重定向、泄漏检测、清理兜底对历史调用透明生效。
 *
 * tests/ 下禁止直接调用 tmpdir() / mkdtemp() / mkdtempSync()，
 * 强制通过 tests/utils/temp.ts 的统一 API 创建临时目录。
 * 对确实需要直接调用的场景（如 temp.ts 自身、subprocess spawn、真实 OS tmpdir
 * 路径刚需等），使用 // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
 * 逐调用点豁免并记录原因。
 *
 * Phase 995 调整：
 * - 不再对任意 `/tmp` 字符串字面量报错（避免误伤 mock 数据 / 渲染文本）。
 * - 不再对 `import { tmpdir }` 报错，改为对 `tmpdir()` 调用点报错。
 * - `mkdtemp*('/tmp/...')` 仍会被检测为硬编码临时目录。
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'tests/ must use temp.ts helpers instead of bare tmpdir/mkdtemp',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      noBareTempdir:
        'Use createTempDir / createTrackedTempDir from tests/utils/temp.ts instead of tmpdir',
      noBareMkdtemp:
        'Use createTempDir / createTrackedTempDir from tests/utils/temp.ts instead of mkdtemp/mkdtempSync',
      noBareOsTmpdir:
        'Use createTempDir / createTrackedTempDir from tests/utils/temp.ts instead of os.tmpdir()',
      noHardcodedTmp:
        'Use createTempDir / createTrackedTempDir from tests/utils/temp.ts instead of hardcoded /tmp path',
    },
  },

  create(context) {
    /**
     * 判断当前节点是否作为参数（含嵌套）出现在 mkdtemp/mkdtempSync 调用中。
     * 用于放行 `fs.mkdtemp(path.join(os.tmpdir(), 'prefix-'))`。
     */
    function isInsideMkdtempArgs(innerNode) {
      let current = innerNode.parent;
      let prev = innerNode;
      while (current && current.type === 'CallExpression') {
        if (current.arguments.includes(prev)) {
          if (
            current.callee.type === 'MemberExpression' &&
            current.callee.object?.type === 'Identifier' &&
            (current.callee.object.name === 'fs' || current.callee.object.name === 'fsNative') &&
            current.callee.property?.type === 'Identifier' &&
            (current.callee.property.name === 'mkdtemp' || current.callee.property.name === 'mkdtempSync')
          ) {
            return true;
          }
          if (
            current.callee.type === 'Identifier' &&
            (current.callee.name === 'mkdtemp' || current.callee.name === 'mkdtempSync')
          ) {
            return true;
          }
        }
        prev = current;
        current = current.parent;
      }
      return false;
    }

    return {
      ImportDeclaration(node) {
        // Block: import { mkdtemp, mkdtempSync } from 'node:fs'
        // （named import 形式；namespace import 的调用由 CallExpression 处理）
        if (node.source.value === 'node:fs' || node.source.value === 'fs') {
          for (const spec of node.specifiers) {
            if (spec.imported?.name === 'mkdtemp' || spec.imported?.name === 'mkdtempSync') {
              context.report({ node: spec, messageId: 'noBareMkdtemp' });
            }
          }
        }
      },

      CallExpression(node) {
        // 1. os.tmpdir() via namespace import
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object?.type === 'Identifier' &&
          node.callee.object.name === 'os' &&
          node.callee.property?.type === 'Identifier' &&
          node.callee.property.name === 'tmpdir'
        ) {
          // 放行作为 mkdtemp 参数的 os.tmpdir()，例如 fs.mkdtemp(path.join(os.tmpdir(), 'prefix-'))
          if (!isInsideMkdtempArgs(node)) {
            context.report({ node, messageId: 'noBareOsTmpdir' });
          }
          return;
        }

        // 2. fs.mkdtemp('/tmp/...') or fs.mkdtempSync('/tmp/...')
        //    or fsNative.mkdtemp*('/tmp/...')
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object?.type === 'Identifier' &&
          (node.callee.object.name === 'fs' || node.callee.object.name === 'fsNative') &&
          node.callee.property?.type === 'Identifier' &&
          (node.callee.property.name === 'mkdtemp' || node.callee.property.name === 'mkdtempSync')
        ) {
          const firstArg = node.arguments[0];
          if (
            firstArg &&
            firstArg.type === 'Literal' &&
            typeof firstArg.value === 'string' &&
            firstArg.value.startsWith('/tmp')
          ) {
            context.report({ node: firstArg, messageId: 'noHardcodedTmp' });
          }
          return;
        }

        // 3. tmpdir() direct call (named import)
        if (node.callee.type === 'Identifier' && node.callee.name === 'tmpdir') {
          context.report({ node, messageId: 'noBareTempdir' });
          return;
        }

        // 4. mkdtemp() / mkdtempSync() direct call (named import)
        if (
          node.callee.type === 'Identifier' &&
          (node.callee.name === 'mkdtemp' || node.callee.name === 'mkdtempSync')
        ) {
          const firstArg = node.arguments[0];
          if (
            firstArg &&
            firstArg.type === 'Literal' &&
            typeof firstArg.value === 'string' &&
            firstArg.value.startsWith('/tmp')
          ) {
            context.report({ node: firstArg, messageId: 'noHardcodedTmp' });
            return;
          }
          context.report({ node, messageId: 'noBareMkdtemp' });
        }
      },
    };
  },
};
