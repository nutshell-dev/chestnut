/**
 * Custom ESLint rule: no-claws-enumeration-fanout
 *
 * 应然 (M#3 资源唯一归属): claws 目录的 enumeration 归属
 * `src/foundation/claw-paths.ts` 一个 owner。其他 caller 必须经此 helper、
 * 不能直接 listSync(<claws dir>, {includeDirs:true})。
 *
 * scope: src/ outside `claw-paths.ts`
 *
 * 匹配的 pattern:
 *   - CallExpression where callee.property.name === 'listSync'
 *   - args[0] source text contains 'claws' or 'Claws' (covers clawsDir / clawsPath / CLAWS_DIR / ...)
 *   - args[1] is ObjectExpression with property `includeDirs: true`
 *
 * Allowlist: only `claw-paths.ts` basename。
 *
 * phase 357: 21st src ESLint rule、共享 phase 309 ESLint infra
 */

const ALLOWLIST_BASENAMES = new Set([
  'claw-paths.ts',
]);

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

function objectHasIncludeDirsTrue(node) {
  if (!node || node.type !== 'ObjectExpression') return false;
  for (const prop of node.properties) {
    if (prop.type !== 'Property') continue;
    const key = prop.key;
    const keyName =
      key.type === 'Identifier' ? key.name :
      key.type === 'Literal' ? String(key.value) :
      null;
    if (keyName !== 'includeDirs') continue;
    const v = prop.value;
    if (v.type === 'Literal' && v.value === true) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/ forbids direct listSync over claws dir; only foundation/claw-paths.ts may enumerate claws (M#3)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      clawsEnumerationFanout:
        'claws enumeration fanout: `{{file}}` uses listSync over claws dir. Only `claw-paths.ts` is authorized to enumerate claws (M#3 resource ownership). Use claw-paths helper instead of direct listSync.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/')) return {};
    if (filename.endsWith('.d.ts')) return {};
    const base = basenameOf(filename);
    if (ALLOWLIST_BASENAMES.has(base)) return {};

    const sourceCode = context.sourceCode || context.getSourceCode();

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'listSync') return;
        if (node.arguments.length < 2) return;
        const arg0Text = sourceCode.getText(node.arguments[0]);
        if (!/[Cc]laws/.test(arg0Text)) return;
        if (!objectHasIncludeDirsTrue(node.arguments[1])) return;
        context.report({
          node,
          messageId: 'clawsEnumerationFanout',
          data: { file: base },
        });
      },
    };
  },
};
