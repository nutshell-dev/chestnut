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
 * Phase 998 调整：
 * - 通过 import binding 跟踪模块来源，不再依赖硬编码标识符名（os/fs/fsNative 等）。
 * - 覆盖 namespace 别名（nodeOs.tmpdir / fsp.mkdtemp）和 named import 别名。
 * - 检测 fs.realpathSync('/tmp') 和 TemplateLiteral `/tmp/...` 形式的硬编码路径。
 */

const OS_MODULES = new Set(['os', 'node:os']);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

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
    // localName → moduleSource (for namespace imports: import * as X from 'Y')
    const namespaceBindings = new Map();
    // localName → { importedName, moduleSource } (for named imports: import { X as Y } from 'Z')
    const namedBindings = new Map();

    /**
     * 检查 mkdtemp/mkdtempSync 的第一个参数是否包含硬编码 /tmp。
     */
    function checkMkdtempFirstArg(node) {
      const firstArg = node.arguments[0];
      if (!firstArg) return;

      if (firstArg.type === 'Literal' && typeof firstArg.value === 'string' && firstArg.value.startsWith('/tmp')) {
        context.report({ node: firstArg, messageId: 'noHardcodedTmp' });
        return;
      }

      if (firstArg.type === 'TemplateLiteral' && firstArg.quasis.length > 0) {
        const firstQuasi = firstArg.quasis[0].value.cooked;
        if (firstQuasi && firstQuasi.startsWith('/tmp')) {
          context.report({ node: firstArg, messageId: 'noHardcodedTmp' });
        }
      }
    }

    /**
     * 判断当前节点是否作为参数（含嵌套）出现在 mkdtemp/mkdtempSync 调用中。
     * 用于放行 `fs.mkdtemp(path.join(os.tmpdir(), 'prefix-'))`。
     */
    function isInsideMkdtempArgs(innerNode) {
      let current = innerNode.parent;
      let prev = innerNode;
      while (current && current.type === 'CallExpression') {
        if (current.arguments.includes(prev)) {
          if (current.callee.type === 'MemberExpression' && current.callee.property?.type === 'Identifier') {
            const propName = current.callee.property.name;
            if (propName === 'mkdtemp' || propName === 'mkdtempSync') {
              const objName = current.callee.object?.type === 'Identifier' ? current.callee.object.name : null;
              if (objName && FS_MODULES.has(namespaceBindings.get(objName) ?? '')) {
                return true;
              }
            }
          }
          if (current.callee.type === 'Identifier') {
            const binding = namedBindings.get(current.callee.name);
            if (
              binding &&
              (binding.importedName === 'mkdtemp' || binding.importedName === 'mkdtempSync') &&
              FS_MODULES.has(binding.moduleSource)
            ) {
              return true;
            }
          }
        }
        prev = current;
        current = current.parent;
      }
      return false;
    }

    return {
      ImportDeclaration(node) {
        const source = node.source.value;

        // Track all namespace and named bindings
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') {
            namespaceBindings.set(spec.local.name, source);
          } else if (spec.type === 'ImportSpecifier' && spec.imported) {
            namedBindings.set(spec.local.name, {
              importedName: spec.imported.name,
              moduleSource: source,
            });
          }
        }

        // 仍对 named import { mkdtemp, mkdtempSync } from fs 报错
        if (FS_MODULES.has(source)) {
          for (const spec of node.specifiers) {
            if (spec.type === 'ImportSpecifier' && spec.imported) {
              if (spec.imported.name === 'mkdtemp' || spec.imported.name === 'mkdtempSync') {
                context.report({ node: spec, messageId: 'noBareMkdtemp' });
              }
            }
          }
        }
      },

      CallExpression(node) {
        // --- os.tmpdir() 检测（任意 namespace 别名）---
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property?.type === 'Identifier' &&
          node.callee.property.name === 'tmpdir'
        ) {
          const objName = node.callee.object?.type === 'Identifier' ? node.callee.object.name : null;
          if (objName && OS_MODULES.has(namespaceBindings.get(objName) ?? '')) {
            if (!isInsideMkdtempArgs(node)) {
              context.report({ node, messageId: 'noBareOsTmpdir' });
            }
            return;
          }
        }

        // --- fs.mkdtemp*() 检测（任意 namespace 别名）---
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property?.type === 'Identifier'
        ) {
          const propName = node.callee.property.name;

          if (propName === 'mkdtemp' || propName === 'mkdtempSync') {
            const objName = node.callee.object?.type === 'Identifier' ? node.callee.object.name : null;
            if (objName && FS_MODULES.has(namespaceBindings.get(objName) ?? '')) {
              checkMkdtempFirstArg(node);
              return;
            }
          }

          // --- fs.realpathSync('/tmp') 检测（任意 namespace 别名）---
          if (propName === 'realpathSync') {
            const objName = node.callee.object?.type === 'Identifier' ? node.callee.object.name : null;
            if (objName && FS_MODULES.has(namespaceBindings.get(objName) ?? '')) {
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
          }
        }

        // --- tmpdir() / mkdtemp*() / realpathSync() 直接调用（named import，任意别名）---
        if (node.callee.type === 'Identifier') {
          const binding = namedBindings.get(node.callee.name);
          if (!binding) return;

          if (binding.importedName === 'tmpdir' && OS_MODULES.has(binding.moduleSource)) {
            context.report({ node, messageId: 'noBareTempdir' });
            return;
          }

          if (
            (binding.importedName === 'mkdtemp' || binding.importedName === 'mkdtempSync') &&
            FS_MODULES.has(binding.moduleSource)
          ) {
            checkMkdtempFirstArg(node);
            context.report({ node, messageId: 'noBareMkdtemp' });
            return;
          }

          if (binding.importedName === 'realpathSync' && FS_MODULES.has(binding.moduleSource)) {
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
        }
      },
    };
  },
};
