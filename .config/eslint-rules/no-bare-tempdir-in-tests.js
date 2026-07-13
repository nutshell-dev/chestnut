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
 * Phase 1000 调整：
 * - 使用 ESLint scope manager 替代自建 bindings Map，消除作用域遮蔽误报。
 * - checkMkdtempFirstArg 递归检测 path.join('/tmp', ...) / path.resolve('/tmp', ...)。
 */

const OS_MODULES = new Set(['os', 'node:os']);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/**
 * 在作用域链中查找名为 `name` 的变量。
 */
function findVariable(scope, name) {
  let current = scope;
  while (current) {
    const v = current.set.get(name);
    if (v) return v;
    current = current.upper;
  }
  return null;
}

/**
 * 判断 `node` 处的标识符 `name` 是否解析为 `modules` 中某个模块的 import binding。
 */
function resolvesToModuleImport(context, node, name, modules) {
  const sourceCode = context.sourceCode || context.getSourceCode?.();
  if (!sourceCode || typeof sourceCode.getScope !== 'function') return false;
  const scope = sourceCode.getScope(node);
  const variable = findVariable(scope, name);
  if (!variable) return false;
  return variable.defs.some(
    d => d.type === 'ImportBinding' && d.parent && modules.has(d.parent.source.value)
  );
}

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
     * 递归检查节点或其子表达式中是否包含硬编码 `/tmp`。
     * 支持 Literal、TemplateLiteral、path.join('/tmp', ...)、path.resolve('/tmp', ...)。
     */
    function containsHardcodedTmp(node) {
      if (!node) return false;

      if (node.type === 'Literal' && typeof node.value === 'string' && node.value.startsWith('/tmp')) {
        return true;
      }

      if (node.type === 'TemplateLiteral' && node.quasis.length > 0) {
        const firstQuasi = node.quasis[0].value.cooked;
        if (firstQuasi && firstQuasi.startsWith('/tmp')) return true;
      }

      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        node.callee.property?.type === 'Identifier'
      ) {
        const propName = node.callee.property.name;
        if (propName === 'join' || propName === 'resolve') {
          for (const arg of node.arguments) {
            if (containsHardcodedTmp(arg)) return true;
          }
        }
      }

      return false;
    }

    /**
     * 检查 mkdtemp/mkdtempSync 的第一个参数是否包含硬编码 /tmp。
     */
    function checkMkdtempFirstArg(node) {
      const firstArg = node.arguments[0];
      if (!firstArg) return;
      if (containsHardcodedTmp(firstArg)) {
        context.report({ node: firstArg, messageId: 'noHardcodedTmp' });
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
              if (objName && resolvesToModuleImport(context, current.callee, objName, FS_MODULES)) {
                return true;
              }
            }
          }
          if (current.callee.type === 'Identifier') {
            if (
              (current.callee.name === 'mkdtemp' || current.callee.name === 'mkdtempSync') &&
              resolvesToModuleImport(context, current, current.callee.name, FS_MODULES)
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
        // --- os.tmpdir() 检测（任意 namespace 别名，感知作用域遮蔽）---
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property?.type === 'Identifier' &&
          node.callee.property.name === 'tmpdir'
        ) {
          const objName = node.callee.object?.type === 'Identifier' ? node.callee.object.name : null;
          if (objName && resolvesToModuleImport(context, node.callee.object, objName, OS_MODULES)) {
            if (!isInsideMkdtempArgs(node)) {
              context.report({ node, messageId: 'noBareOsTmpdir' });
            }
            return;
          }
        }

        // --- fs.mkdtemp*() 检测（任意 namespace 别名，感知作用域遮蔽）---
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property?.type === 'Identifier'
        ) {
          const propName = node.callee.property.name;

          if (propName === 'mkdtemp' || propName === 'mkdtempSync') {
            const objName = node.callee.object?.type === 'Identifier' ? node.callee.object.name : null;
            if (objName && resolvesToModuleImport(context, node.callee.object, objName, FS_MODULES)) {
              checkMkdtempFirstArg(node);
              return;
            }
          }

          // --- fs.realpathSync('/tmp') 检测 ---
          if (propName === 'realpathSync') {
            const objName = node.callee.object?.type === 'Identifier' ? node.callee.object.name : null;
            if (objName && resolvesToModuleImport(context, node.callee.object, objName, FS_MODULES)) {
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
          const calleeName = node.callee.name;
          const sourceCode2 = context.sourceCode || context.getSourceCode?.();
          const variable = sourceCode2 ? findVariable(sourceCode2.getScope(node.callee), calleeName) : null;

          const importDef = variable?.defs.find(d => d.type === 'ImportBinding');
          if (!importDef || !importDef.parent) return;

          const importedName = importDef.node?.imported?.name ?? importDef.node?.local?.name;
          const moduleSource = importDef.parent.source.value;

          if (OS_MODULES.has(moduleSource) && importedName === 'tmpdir') {
            context.report({ node, messageId: 'noBareTempdir' });
            return;
          }

          if (FS_MODULES.has(moduleSource)) {
            if (importedName === 'mkdtemp' || importedName === 'mkdtempSync') {
              checkMkdtempFirstArg(node);
              context.report({ node, messageId: 'noBareMkdtemp' });
              return;
            }
            if (importedName === 'realpathSync') {
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
      },
    };
  },
};
