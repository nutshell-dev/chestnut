/**
 * Custom ESLint rule: no-direct-process-exit-in-cli
 *
 * 应然：src/cli/ 内 caller 必经 handleCliError + with-cli-error-handling wrapper、
 * 不直调 process.exit()。
 *
 * scope: src/cli/ subset
 * allow-list: 3 边界 site（spawn re-entry / stdout drain / daemonized spawn）
 *
 * phase 312 cluster C close 第 2 rule（替代 phase 1230 grep ratchet）
 */

const ALLOW_LIST = [
  'src/cli/with-cli-error-handling.ts',
  'src/cli/commands/chat-viewport-init.ts',
  'src/cli/commands/subagent-steps.ts',
  // phase 544 (lint:no-direct-process-exit): claw-stream 是长跑 stream tail CLI、
  // SIGINT/SIGTERM 后 shutdown() 内 reader.stop() 完成后立即 process.exit；不依赖
  // process.exitCode 自然 drain（防 stream 输出 race + 长跑期间 audit 写入卡 exit）。
  'src/cli/commands/claw-stream.ts',
];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'src/cli/ 内禁直调 process.exit()、必经 handleCliError + with-cli-error-handling wrapper（除 3 边界 site allow）',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      directProcessExit: 'Direct process.exit() call in src/cli/. Use handleCliError + with-cli-error-handling wrapper. Allow-list (3 boundary sites): spawn re-entry / stdout drain / daemonized spawn.',
    },
  },

  create(context) {
    const filename = context.filename;

    // scope: 仅 src/cli/ 内 enforce（兼容 RuleTester 相对 path 与 ESLint 绝对 path）
    const isInCliScope = filename.includes('/src/cli/') || filename.startsWith('src/cli/');
    if (!isInCliScope) return {};

    // allow-list (相对 path endsWith 匹配)
    if (ALLOW_LIST.some(p => filename.endsWith(p))) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        // `process.exit(...)` AST
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'process' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'exit'
        ) {
          context.report({ node, messageId: 'directProcessExit' });
        }
      },
    };
  },
};
