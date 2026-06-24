/**
 * Custom ESLint rule: no-clawdir-path-anti-pattern
 *
 * 应然 (phase 1387 + 1388 + 1389): caller 不用 path 操作从 clawDir / agentDir
 * 反推 chestnutRoot。必经 helper SoT (M#3 + M#9):
 *   - `getChestnutRoot()` env-based
 *   - `ctx.chestnutRoot` injected
 *   - `path.join(ctx.chestnutRoot, CLAWS_DIR)` 正确 pattern
 *
 * 3 sub-pattern (Motion-only 注释豁免):
 *   (1) resolve(*clawDir, '..', CLAWS_DIR) — phase 1387
 *   (2) path.dirname(*clawDir|agentDir) — phase 1388
 *   (3) makeChestnutRoot(path.join(*clawDir|agentDir, '..')) — phase 1389 A
 *
 * phase 327 cluster A-path-branded close 替代 grep ratchet
 * 共享 phase 309 ESLint infra / phase 312/315/322 模板
 */

const MOTION_ONLY = 'Motion-only';

function hasMotionOnlyComment(node, sourceCode) {
  // 检查 node 所在行 / 上方注释 是否含 'Motion-only'
  const comments = sourceCode.getCommentsBefore(node);
  if (comments.some(c => c.value.includes(MOTION_ONLY))) return true;
  // 行内 trailing comment
  const trailing = sourceCode.getCommentsAfter(node);
  if (trailing.some(c => c.value.includes(MOTION_ONLY))) return true;
  // 同行 // comment
  const line = node.loc.start.line;
  const lineText = sourceCode.lines[line - 1] || '';
  if (lineText.includes(MOTION_ONLY)) return true;
  return false;
}

function isClawDirOrAgentDir(node) {
  if (node.type === 'Identifier') {
    return node.name === 'clawDir' || node.name === 'agentDir';
  }
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    return node.property.name === 'clawDir' || node.property.name === 'agentDir';
  }
  return false;
}

function isLiteralString(node, value) {
  return node.type === 'Literal' && node.value === value;
}

function isCallTo(node, objectName, methodName) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression') return false;
  if (callee.object.type !== 'Identifier' || callee.object.name !== objectName) return false;
  if (callee.property.type !== 'Identifier' || callee.property.name !== methodName) return false;
  return true;
}

function isIdentifierCall(node, name) {
  if (node.type !== 'CallExpression') return false;
  return node.callee.type === 'Identifier' && node.callee.name === name;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No path-based reverse-derive of chestnutRoot from clawDir/agentDir (M#3 + M#9 + phase 1387/1388/1389)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      patternResolveParentClaws:
        'Anti-pattern: resolve(clawDir, "..", CLAWS_DIR). Use path.join(ctx.chestnutRoot, CLAWS_DIR) instead.',
      patternDirnameClawdir:
        'Anti-pattern: path.dirname({{name}}). Use getChestnutRoot() or ctx.chestnutRoot instead (Motion-only callsite must add // Motion-only comment for exemption).',
      patternSingleUpMakeRoot:
        'Anti-pattern: makeChestnutRoot(path.join({{name}}, "..")) single-up. Use double-up path.join({{name}}, "..", "..") or Motion-only exemption.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();

    // Track whether we are inside the resolveChestnutRoot helper, where the
    // motion branch intentionally uses a single-up path.join(clawDir, '..').
    let resolveChestnutRootDepth = 0;

    return {
      FunctionDeclaration(node) {
        if (node.id && node.id.name === 'resolveChestnutRoot') {
          resolveChestnutRootDepth++;
        }
      },
      'FunctionDeclaration:exit'(node) {
        if (node.id && node.id.name === 'resolveChestnutRoot') {
          resolveChestnutRootDepth--;
        }
      },
      FunctionExpression(node) {
        if (node.id && node.id.name === 'resolveChestnutRoot') {
          resolveChestnutRootDepth++;
        }
      },
      'FunctionExpression:exit'(node) {
        if (node.id && node.id.name === 'resolveChestnutRoot') {
          resolveChestnutRootDepth--;
        }
      },

      // (1) resolve(*clawDir, '..', CLAWS_DIR)
      CallExpression(node) {
        // path.resolve(...) check
        if (isCallTo(node, 'path', 'resolve') || isCallTo(node, 'nodePath', 'resolve')) {
          const args = node.arguments;
          // args has clawDir + '..' + CLAWS_DIR pattern
          const hasClawDir = args.some(a => isClawDirOrAgentDir(a));
          const hasDotDot = args.some(a => isLiteralString(a, '..'));
          const hasClawsDir =
            args.some(a => a.type === 'Identifier' && a.name === 'CLAWS_DIR') ||
            args.some(a => isLiteralString(a, 'claws')) ||
            args.some(a => isLiteralString(a, '.claws'));
          if (hasClawDir && hasDotDot && hasClawsDir) {
            context.report({ node, messageId: 'patternResolveParentClaws' });
            return;
          }
        }

        // (2) path.dirname(*clawDir|agentDir)
        if (isCallTo(node, 'path', 'dirname') || isCallTo(node, 'nodePath', 'dirname')) {
          if (node.arguments.length >= 1 && isClawDirOrAgentDir(node.arguments[0])) {
            if (!hasMotionOnlyComment(node, sourceCode)) {
              const nameNode = node.arguments[0];
              const name =
                nameNode.type === 'Identifier'
                  ? nameNode.name
                  : nameNode.type === 'MemberExpression' && nameNode.property.type === 'Identifier'
                    ? nameNode.property.name
                    : '<expr>';
              context.report({
                node,
                messageId: 'patternDirnameClawdir',
                data: { name },
              });
              return;
            }
          }
        }

        // (3) makeChestnutRoot(path.join(*clawDir|agentDir, '..')) single-up
        if (isIdentifierCall(node, 'makeChestnutRoot')) {
          const arg = node.arguments[0];
          if (arg && (isCallTo(arg, 'path', 'join') || isCallTo(arg, 'nodePath', 'join'))) {
            const joinArgs = arg.arguments;
            // first arg = clawDir/agentDir
            if (joinArgs.length >= 1 && isClawDirOrAgentDir(joinArgs[0])) {
              // count '..' literals
              const dotDots = joinArgs.filter(a => isLiteralString(a, '..')).length;
              if (dotDots === 1) {
                // single-up = anti-pattern (need double-up for chestnutRoot),
                // unless inside resolveChestnutRoot where the motion branch is intentional.
                if (!hasMotionOnlyComment(node, sourceCode) && resolveChestnutRootDepth === 0) {
                  const nameNode = joinArgs[0];
                  const name =
                    nameNode.type === 'Identifier'
                      ? nameNode.name
                      : nameNode.type === 'MemberExpression' && nameNode.property.type === 'Identifier'
                        ? nameNode.property.name
                        : '<expr>';
                  context.report({
                    node,
                    messageId: 'patternSingleUpMakeRoot',
                    data: { name },
                  });
                }
              }
            }
          }
        }
      },
    };
  },
};
