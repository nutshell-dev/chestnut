/**
 * Custom ESLint rule: no-runtime-knows-upper-layer-messages
 *
 * 应然 (phase 1414): Runtime 不字面持上下游 inbox message type 措辞 / FS 读 /
 * 业主 audit。
 *
 * scope: src/core/runtime/ outside .d.ts
 *
 * 3 sub-invariant:
 *   1. 'crash_notification' string literal — M#5 反向防护 (Watchdog L6 业主)
 *   2. 'HEARTBEAT.md' string literal — M#2/#3 业务归属防护 (Heartbeat L5 业主)
 *   3. `HEARTBEAT_AUDIT_EVENTS` import or member use — M#3 audit 归属防护
 *      (allows barrel re-export from runtime/index.ts via ExportSpecifier、
 *       原 vitest contract `import\s*\{...\}` 仅 ban import keyword)
 *
 * Comments / jsdoc allowed (AST visitor 不 visit comment node).
 *
 * phase 383: 26th src ESLint rule
 */

const BANNED_LITERALS = new Set(['crash_notification', 'HEARTBEAT.md']);
const BANNED_IDENT = 'HEARTBEAT_AUDIT_EVENTS';

function basenameOf(filepath) {
  const idx = filepath.lastIndexOf('/');
  return idx === -1 ? filepath : filepath.slice(idx + 1);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'src/core/runtime/ forbids upper-layer (Heartbeat L5 / Watchdog L6) literal / import (phase 1414)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      crashNotificationLiteral:
        "Runtime persists upper-layer inbox literal 'crash_notification' in `{{file}}`. M#5 反向防护: Watchdog L6 业主 (phase 1414).",
      heartbeatMdPath:
        "Runtime persists upper-layer FS path 'HEARTBEAT.md' in `{{file}}`. M#2/#3 业务归属防护: Heartbeat L5 业主 (phase 1414).",
      heartbeatAuditEventsImportOrUse:
        'Runtime imports or uses `HEARTBEAT_AUDIT_EVENTS` in `{{file}}`. M#3 audit 归属防护: Heartbeat L5 业主 own audit (phase 1414). Barrel re-export from runtime/index.ts is allowed.',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!filename.includes('src/core/runtime/')) return {};
    if (filename.endsWith('.d.ts')) return {};

    const base = basenameOf(filename);

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (!BANNED_LITERALS.has(node.value)) return;
        if (node.value === 'crash_notification') {
          context.report({ node, messageId: 'crashNotificationLiteral', data: { file: base } });
        } else if (node.value === 'HEARTBEAT.md') {
          context.report({ node, messageId: 'heartbeatMdPath', data: { file: base } });
        }
      },
      ImportDeclaration(node) {
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier') continue;
          if (spec.imported.type !== 'Identifier') continue;
          if (spec.imported.name !== BANNED_IDENT) continue;
          context.report({
            node: spec,
            messageId: 'heartbeatAuditEventsImportOrUse',
            data: { file: base },
          });
        }
      },
      MemberExpression(node) {
        if (node.object.type !== 'Identifier') return;
        if (node.object.name !== BANNED_IDENT) return;
        context.report({
          node,
          messageId: 'heartbeatAuditEventsImportOrUse',
          data: { file: base },
        });
      },
    };
  },
};
