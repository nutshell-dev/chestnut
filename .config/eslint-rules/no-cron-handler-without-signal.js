/**
 * Custom ESLint rule: no-cron-handler-without-signal
 *
 * 应然 (phase 1266 r135 B fork): cron job factory `handler: () => ...` 必接
 * `signal` 参 (cooperative abort)。否则 signal cascade 在长跑 handler 内丢、
 * stop/restart race 失稳。
 *
 * scope: src/foundation/cron/jobs/ + src/core/contract/jobs/ outside .d.ts (phase 697 Step A: cron 迁 foundation)
 *
 * 匹配的 pattern:
 *   Property where key.name === 'handler', value is
 *   ArrowFunctionExpression with params.length === 0 → report
 *   (sync or async arrow, 0 param)
 *
 * phase 423: 45th src ESLint rule
 */

// phase 697 Step A: cron 物理迁 src/core/cron/ → src/foundation/cron/
const SCOPE_PREFIXES = [
  'src/foundation/cron/jobs/',
  'src/core/contract/jobs/',
];

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

function inScope(filename) {
  return SCOPE_PREFIXES.some((p) => filename.includes(p));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'cron job factory handler arrow must wire signal param (phase 1266 r135 B fork)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      cronHandlerNoSignal:
        '`handler: () =>` missing signal param in `{{file}}` (cron job factory). Wire `handler: (signal) =>` or `async (signal) =>` for cooperative abort.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!inScope(filename)) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = basenameOf(filename);

    return {
      Property(node) {
        if (node.key.type !== 'Identifier' || node.key.name !== 'handler') return;
        const v = node.value;
        if (v.type !== 'ArrowFunctionExpression' && v.type !== 'FunctionExpression') return;
        if (v.params.length !== 0) return;
        context.report({
          node,
          messageId: 'cronHandlerNoSignal',
          data: { file: base },
        });
      },
    };
  },
};
