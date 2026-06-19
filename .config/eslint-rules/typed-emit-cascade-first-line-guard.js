/**
 * Custom ESLint rule: typed-emit-cascade-first-line-guard
 *
 * 应然 (phase 1267 D.1): every `export function emitContract*` with `contractId`
 * in opts type must call `assertContractIdNonEmpty(audit, opts.contractId,
 * '<fnname>')` as its first body statement.
 *
 * scope: src/core/contract/audit-emit.ts
 *
 * 匹配的 pattern:
 *   ExportNamedDeclaration where declaration is FunctionDeclaration
 *   with id.name matching /^emitContract/ AND second parameter type contains
 *   `contractId` property → first body statement must be
 *   ExpressionStatement with CallExpression to assertContractIdNonEmpty(
 *     audit, opts.contractId, '<fnname>'
 *   ).
 *
 * phase 424: 46th src ESLint rule
 */

const TARGET_SUFFIX = 'src/core/contract/audit-emit.ts';

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

function paramHasContractId(param) {
  if (!param) return false;
  // Look for `opts: { contractId: ... }` or similar TSTypeLiteral
  const ann = param.typeAnnotation && param.typeAnnotation.typeAnnotation;
  if (!ann) return false;
  if (ann.type !== 'TSTypeLiteral') return false;
  if (!Array.isArray(ann.members)) return false;
  for (const member of ann.members) {
    if (member.type !== 'TSPropertySignature') continue;
    if (member.key && member.key.type === 'Identifier' && member.key.name === 'contractId') {
      return true;
    }
  }
  return false;
}

function isFirstStmtValidGuard(body, fnName, sourceCode) {
  if (!body || !Array.isArray(body.body) || body.body.length === 0) return false;
  const first = body.body[0];
  // Mirror vitest substring check on first statement source text. Accepts both
  // bare `assertContractIdNonEmpty(...)` and `if (!assertContractIdNonEmpty(...)) return;` patterns.
  const text = sourceCode.getText(first);
  const expected = `assertContractIdNonEmpty(audit, opts.contractId, '${fnName}')`;
  return text.includes(expected);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        '`emitContract*` functions with contractId opts must guard first line via assertContractIdNonEmpty',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      missingFirstLineGuard:
        '`{{name}}` in `{{file}}` is missing first-line `assertContractIdNonEmpty(audit, opts.contractId, \'{{name}}\')` guard (phase 1267 D.1).',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.endsWith(TARGET_SUFFIX)) return {};

    const base = basenameOf(filename);

    const sourceCode = context.sourceCode || context.getSourceCode();

    function checkFn(node, fnName) {
      // Mirror vitest contract: only check functions whose 2nd param is named `opts`
      // (vitest grep `opts:\s*\{[^}]*contractId/` skips other param names like `fields`).
      const optsParam = node.params && node.params[1];
      if (!optsParam || optsParam.type !== 'Identifier' || optsParam.name !== 'opts') return;
      if (!paramHasContractId(optsParam)) return;
      if (isFirstStmtValidGuard(node.body, fnName, sourceCode)) return;
      context.report({
        node,
        messageId: 'missingFirstLineGuard',
        data: { name: fnName, file: base },
      });
    }

    return {
      ExportNamedDeclaration(node) {
        const decl = node.declaration;
        if (!decl) return;
        if (decl.type !== 'FunctionDeclaration') return;
        if (!decl.id || decl.id.type !== 'Identifier') return;
        if (!/^emitContract/.test(decl.id.name)) return;
        checkFn(decl, decl.id.name);
      },
    };
  },
};
