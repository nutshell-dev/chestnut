/**
 * Custom ESLint rule: no-bare-tempdir-in-tests
 *
 * 应然：tests/ 下所有临时目录创建都应经过 tests/utils/temp.ts 的统一封装，
 * 使 TMPDIR 重定向、泄漏检测、清理兜底对历史调用透明生效。
 *
 * tests/ 下禁止直接调用 tmpdir() / mkdtemp() / mkdtempSync()，
 * 强制通过 tests/utils/temp.ts 的统一 API 创建临时目录。
 * 对确实需要直接调用的场景（如 temp.ts 自身、subprocess spawn、真实 OS tmpdir
 * 路径刚需等），使用 // eslint-disable-next-line no-bare-tempdir-in-tests
 * 逐调用点豁免并记录原因。
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
    return {
      ImportDeclaration(node) {
        // Block: import { tmpdir } from 'node:os'
        if (node.source.value === 'node:os' || node.source.value === 'os') {
          for (const spec of node.specifiers) {
            if (spec.imported?.name === 'tmpdir') {
              context.report({ node: spec, messageId: 'noBareTempdir' });
            }
          }
        }
        // Block: import { mkdtemp, mkdtempSync } from 'node:fs'
        if (node.source.value === 'node:fs' || node.source.value === 'fs') {
          for (const spec of node.specifiers) {
            if (spec.imported?.name === 'mkdtemp' || spec.imported?.name === 'mkdtempSync') {
              context.report({ node: spec, messageId: 'noBareMkdtemp' });
            }
          }
        }
      },
      CallExpression(node) {
        // Block: os.tmpdir() via namespace import
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object?.type === 'Identifier' &&
          node.callee.object.name === 'os' &&
          node.callee.property?.type === 'Identifier' &&
          node.callee.property.name === 'tmpdir'
        ) {
          context.report({ node, messageId: 'noBareOsTmpdir' });
          return;
        }

        // Block: fs.mkdtemp('/tmp/...') or fs.mkdtempSync('/tmp/...')
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
        }
      },

      Literal(node) {
        // 避免与 CallExpression 中对 fs.mkdtemp*('/tmp...') 的报告重复
        const parent = node.parent;
        if (
          parent?.type === 'CallExpression' &&
          parent.arguments[0] === node &&
          parent.callee.type === 'MemberExpression' &&
          parent.callee.object?.type === 'Identifier' &&
          (parent.callee.object.name === 'fs' || parent.callee.object.name === 'fsNative') &&
          parent.callee.property?.type === 'Identifier' &&
          (parent.callee.property.name === 'mkdtemp' || parent.callee.property.name === 'mkdtempSync')
        ) {
          return;
        }

        if (
          typeof node.value === 'string' &&
          /^\/tmp\b/.test(node.value) &&
          // 排除 temp.ts / run-root.ts 等封装层中的字面量
          !context.filename.includes('tests/utils/temp.ts') &&
          !context.filename.includes('tests/utils/run-root.ts')
        ) {
          context.report({ node, messageId: 'noHardcodedTmp' });
        }
      },
    };
  },
};
