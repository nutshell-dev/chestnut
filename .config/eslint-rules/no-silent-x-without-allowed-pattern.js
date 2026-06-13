/**
 * Custom ESLint rule: no-silent-x-without-allowed-pattern
 *
 * 应然 (phase 964 r119 C fork + phase 268 baseline prune): src/ 每个 catch 块
 * body 必含 audit / throw / console / silent-annotation / structured-handler
 * 之一、否则视为 silent fail、违反 DP-2「错误暴露而非吞没」。
 *
 * scope: src/ (.ts、非 .d.ts)
 *
 * 匹配的 pattern:
 *   1. block catch { ... } — CatchClause AST 节点
 *   2. .catch(arrow) — CallExpression w/ MemberExpression .catch + ArrowFunctionExpression/FunctionExpression arg
 *
 * 规则：对 catch body source text 跑 ALLOWED_PATTERNS regex 列表、任一命中 = 合规。
 *
 * baseline: phase 268 pruned to 0 entry、当前规则不需 baseline 机制。
 * future 若重启可用 `eslint-disable-next-line` 或 file override config。
 *
 * phase 349: 19th src ESLint rule、共享 phase 309 ESLint infra
 * framing 锚 N=17 严守 N=4 + framing bias N=18 vindicate N=2 + T3 cluster ESLint 替代收官
 */

const ALLOWED_PATTERNS = [
  // Canonical silent annotation
  /\/\/\s*silent:/,
  /\/\*\s*silent:/,
  // Audit
  /\baudit/,
  /\bauditWriter\??\.write\(/,
  // Throw
  /\bthrow\b/,
  // Console
  /\bconsole\.(error|warn|log|info|debug)\(/,
  // Process exit
  /\bprocess\.exitCode\s*=/,
  /\bprocess\.exit\(/,
  // Error handling helpers
  /\bhandleCliError\b/,
  /\bfireTransportError\b/,
  /\bonStreamParseError\b/,
  /\bdropConnection\b/,
  /\bbackupCorrupt\b/,
  /\bremoveWatchdogPid\b/,
  /\blogWithAudit\b/,
  // Logging / output
  /\blog\(/,
  /\bappendOutput\b/,
  /\blines\.push\(/,
  // Structured error returns
  /\breturn\s*\{\s*(success|ok|passed|alive|winner|error|content|reason|lastEventMs|lastError|pid|command)/,
  /\breturn\s+(false|true|0|null|undefined|await|base|this\.)/,
  /\breturn\s*;/,
  /\breturn\s*\[\]/,
  /\breturn\s+pids\.map/,
  /\breturn\s+errResult\(/,
  // Control flow
  /\bcontinue\s*;/,
  // Conditional handling
  /\bif\s*\(\s*(err|error)/,
  /\bif\s*\(\s*\(/,
  // Assignments that indicate handling
  /\b(errorText|moveOk|saveFailed|moveErr|skillsSource|srcPath|result|lines|contractAudit|motionAudit|shimAudit|systemAudit|auditError|handlerPromise|track\.isAlive)\s*=/,
  /\bconst\s+\w+\s*=\s*(err|error)/,
  // Generic function calls that indicate non-silent
  /\bPromise\.reject\(/,
  /\bonSkip\(/,
  /\bturnTracker\.forceReset\(/,
  /\bformatErr\(/,
  // Generic write/error calls from audit-like objects
  /\b\w*[Aa]udit\w*\.write\(/,
  /\b\w*[Ee]rror\w*\(/,
];

function isAllowed(bodyText) {
  return ALLOWED_PATTERNS.some((p) => p.test(bodyText));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ catch body must contain audit / throw / console / silent-annotation / structured-handler (phase 964 + 268)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      silentXNotAllowed:
        'Silent catch in `{{file}}` body has no allowed pattern (audit / throw / console / silent:-annotation / structured-handler). DP-2: errors must be exposed, not swallowed. Options: (a) add audit.write(err) / throw / console.error(err) / (b) add `// silent: <reason>` annotation if intentional fail-soft.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const sourceCode = context.sourceCode || context.getSourceCode();
    const base = (() => {
      const idx = filename.lastIndexOf('/');
      return idx === -1 ? filename : filename.slice(idx + 1);
    })();

    function checkBody(bodyNode, reportNode) {
      if (!bodyNode || bodyNode.type !== 'BlockStatement') return;
      const bodyText = sourceCode.getText(bodyNode);
      if (isAllowed(bodyText)) return;
      context.report({
        node: reportNode,
        messageId: 'silentXNotAllowed',
        data: { file: base },
      });
    }

    return {
      CatchClause(node) {
        checkBody(node.body, node);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'catch') return;
        const arg = node.arguments[0];
        if (!arg) return;
        if (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression') return;
        if (arg.body.type !== 'BlockStatement') return;
        checkBody(arg.body, node);
      },
    };
  },
};
