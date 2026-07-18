/**
 * Custom ESLint rule: no-silent-catch-outside-allowlist
 *
 * 应然 (phase 1324 C.4 + phase 272 Step E): src/ silent catch (empty body
 * OR silent-marker block-comment body) 必属 by-design fail-soft / best-effort
 * / race 路径、显式落 allowlist file basename。否则 silent fail 隐藏 DP-2
 *「错误暴露而非吞没」。
 *
 * scope: src/ outside allowlist
 *
 * 匹配的 pattern:
 *   1. catch block with empty body
 *   2. catch block with silent-marker comment-only body
 *   3. .catch(() => {}) / .catch((e) => {}) bare arrow empty body Promise catch
 *
 * Allowlist (19 file basenames) covers historical by-design fail-soft / race / best-effort 路径。
 *
 * phase 343 framing 锚 N=17 严守 N=3 + framing bias N=18 vindicate N=1 (src-targeting + ESLint AST 可)
 * 共享 phase 309 ESLint infra (18th rule)
 */

const ALLOWLIST_BASENAMES = new Set([
  // phase 1324 ratify
  'task-recovery.ts',
  'orchestrator.ts',
  // phase 272 Step E baseline
  'chat-viewport-init.ts',
  'chat-viewport-input.ts',
  // phase 367: viewport task stale cleanup audit self-failure tolerated
  'chat-viewport.ts',
  'claw-list.ts',
  'claw-trace.ts',
  'daemon-entry.ts',
  'daemon-handlers.ts',
  'daemon.ts',
  'ensure.ts',
  'inbox-watcher.ts',
  'onboarding-discovery.ts',
  'orphan-sweep.ts',
  'reader.ts',
  // phase 343: audit recursion border (sibling to reader.ts; per-origin/per-file
  // best-effort cleanup paths; cannot self-audit on failure — DP-2 fallback border).
  'writer.ts',
  'stop.ts',
  // phase 1124: claw-stop failure-path clean-stop marker cleanup is by-design best-effort;
  // cleanup failure does not affect correctness (CliError is still thrown) and any residual
  // marker only causes a spurious ungraceful warning on the next boot.
  'claw-stop.ts',
  'subagent-helpers.ts',
  'timeout-controller.ts',
  'watchdog-state.ts',
  'watchdog-utils.ts',
  'watcher.ts',
  // phase 697: best-effort drain of in-flight stream state before rethrow;
  // original error is preserved and rethrown on line 284.
  'llm-stream-collector.ts',
  // phase 752: lightweight read-only query helpers are intentionally fail-soft;
  // unreadable/race paths return null / degraded result to callers without audit dependency.
  'lightweight-query.ts',
  'list-archive.ts',
  // phase 1047: per-contender 文件锁协议核心原语；所有 silent catch 均为并发 race /
  // best-effort cleanup 路径（自残留清理、stale recovery、落选者自删、release no-op），
  // 失败不影响正确性，残留由后续 contender 的 stale recovery 处理。
  'lock-protocol.ts',
]);

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

function isEmptyBody(blockNode, sourceCode) {
  if (!blockNode || blockNode.type !== 'BlockStatement') return false;
  if (blockNode.body.length !== 0) return false;
  // Mirror vitest grep `\.catch\(\(\)\s*=>\s*\{\s*\}\)`: no comments either.
  // `.catch(() => { /* x */ })` is NOT flagged (grep pattern only matched bare `{}`).
  if (sourceCode) {
    const comments = sourceCode.getCommentsInside(blockNode);
    if (comments.length > 0) return false;
  }
  return true;
}

function hasSilentMarker(blockNode, sourceCode) {
  if (!blockNode || blockNode.type !== 'BlockStatement') return false;
  // Mirror phase 1324/272 vitest grep pattern exactly:
  //   `}\s*catch\s*\{\s*/\*\s*silent`
  // i.e. silent-marker block comment must start on the SAME LINE as catch body `{`.
  // Multi-line silent block catches are NOT flagged (escape grep, mirror behavior).
  const openLine = blockNode.loc.start.line;
  const comments = sourceCode.getCommentsInside(blockNode);
  return comments.some(
    (c) => c.type === 'Block' && c.loc.start.line === openLine && /^\s*silent\s*:/.test(c.value),
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ silent catch (empty / silent-marker comment-only) must belong to allowlist (phase 1324 + 272)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      silentCatchOutside:
        'Silent catch in `{{file}}` not in allowlist. Allowed only for by-design fail-soft / best-effort / race paths. Add basename to rule ALLOWLIST_BASENAMES with design rationale, or replace silent body with audit/throw/console.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    const base = basenameOf(filename);
    if (ALLOWLIST_BASENAMES.has(base)) return {};

    const sourceCode = context.sourceCode || context.getSourceCode();

    function report(node) {
      context.report({
        node,
        messageId: 'silentCatchOutside',
        data: { file: base },
      });
    }

    return {
      // Block catch form: flag iff body contains silent-marker comment
      // (mirror phase 1324/272 vitest pattern: `} catch { /* silent`).
      CatchClause(node) {
        if (hasSilentMarker(node.body, sourceCode)) report(node);
      },
      // Promise form `.catch(() => {})`: flag iff arrow body is empty
      // (mirror phase 1324/272 vitest pattern: `.catch(() => {})`).
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'catch') return;
        const arg = node.arguments[0];
        if (!arg) return;
        if (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression') return;
        if (arg.body.type !== 'BlockStatement') return;
        if (isEmptyBody(arg.body, sourceCode)) report(node);
      },
    };
  },
};
