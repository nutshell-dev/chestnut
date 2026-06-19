/**
 * Custom ESLint rule: no-entry-literal-outside-allowlist
 *
 * 应然 (phase 1436 + phase 72): `daemon-entry.js` / `watchdog-entry.js` 字符串
 * 字面量在 src/ 内的单一权威 = assembly/spawn-entry.ts (resolveDaemonEntry /
 * resolveWatchdogEntry helper)。其他文件不得持有该字面量。
 *
 * scope: src/ outside .d.ts and outside per-literal allowlist.
 *
 * 匹配的 pattern:
 *   Literal where value contains 'daemon-entry.js' or 'watchdog-entry.js'.
 *
 * Allowlist (per literal):
 *   - daemon-entry.js:
 *       - src/cli/commands/stop.ts (pgrep substring match)
 *       - src/assembly/spawn-entry.ts (the helper itself)
 *       - src/foundation/process-manager/types.ts (JSDoc example)
 *   - watchdog-entry.js:
 *       - src/assembly/spawn-entry.ts
 *       - src/watchdog/orphan-sweep.ts
 *
 * phase 420: 44th src ESLint rule
 */

const DAEMON_ALLOWLIST = [
  'src/cli/commands/stop.ts',
  'src/assembly/spawn-entry.ts',
  'src/foundation/process-manager/types.ts',
];
const WATCHDOG_ALLOWLIST = [
  'src/assembly/spawn-entry.ts',
  'src/watchdog/orphan-sweep.ts',
];

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

function endsWithAny(filename, suffixes) {
  return suffixes.some((s) => filename.endsWith(s));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ forbids daemon-entry.js / watchdog-entry.js literal outside allowlist (phase 1436 + 72)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      daemonEntryLiteral:
        '`daemon-entry.js` literal in `{{file}}` outside allowlist. Use assembly/spawn-entry.ts resolveDaemonEntry helper.',
      watchdogEntryLiteral:
        '`watchdog-entry.js` literal in `{{file}}` outside allowlist. Use assembly/spawn-entry.ts resolveWatchdogEntry helper.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = basenameOf(filename);

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const v = node.value;
        if (v.includes('daemon-entry.js') && !endsWithAny(filename, DAEMON_ALLOWLIST)) {
          context.report({
            node,
            messageId: 'daemonEntryLiteral',
            data: { file: base },
          });
        }
        if (v.includes('watchdog-entry.js') && !endsWithAny(filename, WATCHDOG_ALLOWLIST)) {
          context.report({
            node,
            messageId: 'watchdogEntryLiteral',
            data: { file: base },
          });
        }
      },
      TemplateElement(node) {
        const v = node.value && node.value.cooked;
        if (typeof v !== 'string') return;
        if (v.includes('daemon-entry.js') && !endsWithAny(filename, DAEMON_ALLOWLIST)) {
          context.report({
            node,
            messageId: 'daemonEntryLiteral',
            data: { file: base },
          });
        }
        if (v.includes('watchdog-entry.js') && !endsWithAny(filename, WATCHDOG_ALLOWLIST)) {
          context.report({
            node,
            messageId: 'watchdogEntryLiteral',
            data: { file: base },
          });
        }
      },
    };
  },
};
