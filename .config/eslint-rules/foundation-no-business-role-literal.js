/**
 * Custom ESLint rule: foundation-no-business-role-literal
 *
 * 应然 (M#5 + phase 117 + phase 1395): L1-L4 (foundation/ + core/) 不持 quoted
 * business caller role literal (motion / claw / subagent / verifier / shadow /
 * miner) 或 `MOTION_CLAW_ID` identifier (同性质硬绑业务上层语义)。
 *
 * Strict scope:
 *   - src/foundation/tool-protocol/ 0 tolerance (no business literal nor caller-type re-export)
 *
 * Allow-list scope:
 *   - src/foundation/ 其他文件如 allow-list 内 (17 file pre-existing tech debt) → 允许
 *   - src/core/ 其他文件如 allow-list 内 (37 file pre-existing tech debt) → 允许
 *   - 其他 L1-L4 文件不在 allow-list → 0 tolerance
 *
 * phase 330 cluster mixed-case-T3.5 close 替代 phase 1395 grep ratchet
 * phase 384 范围扩 L1-L4 + MOTION_CLAW_ID + 合并 phase 117 vitest ratchet
 * 共享 phase 309 ESLint infra
 */

const BUSINESS_ROLES = ['motion', 'claw', 'subagent', 'verifier', 'shadow', 'miner'];

const FOUNDATION_ALLOW_LIST_SUFFIXES = [
  // 17 file (phase 384: 去 stale config/schemas.ts + 加 messaging/notify.ts 与 vitest 对齐)
  'src/foundation/command-tool/exec.ts',
  'src/foundation/file-tool/edit.ts',
  'src/foundation/file-tool/ls.ts',
  'src/foundation/file-tool/multi_edit.ts',
  'src/foundation/file-tool/read.ts',
  'src/foundation/file-tool/search.ts',
  'src/foundation/file-tool/write.ts',
  'src/foundation/messaging/notify.ts',
  'src/foundation/messaging/tools/notify-claw.ts',
  'src/foundation/messaging/tools/send.ts',
  'src/foundation/process-manager/agent-factory.ts',
  'src/foundation/process-manager/types.ts',
  'src/foundation/skill-system/tools/skill.ts',
  'src/foundation/tools/context.ts',
  'src/foundation/tools/executor.ts',
  'src/foundation/tools/types.ts',
];

const CORE_ALLOW_LIST_SUFFIXES = [
  // 37 file from phase 117 vitest baseline (phase 384 merge in)
  'src/core/async-task-system/result-delivery.ts',
  'src/core/async-task-system/subagent-executor.ts',
  'src/core/async-task-system/system.ts',
  'src/core/async-task-system/task-schemas.ts',
  'src/core/async-task-system/tools/_pending-tool-task-writer.ts',
  'src/core/async-task-system/types.ts',
  'src/core/caller-types.ts',
  'src/core/contract/jobs/contract-observer.ts',
  'src/core/contract/verifier-job.ts',
  'src/core/cron/jobs/llm-stats.ts',
  'src/core/cron/jobs/git-gc-weekly-audit-events.ts',
  'src/core/evolution-system/retro-scheduler.ts',
  'src/core/heartbeat/heartbeat.ts',
  'src/core/memory/random-dream.ts',
  'src/core/memory/tools/memory_search.ts',
  'src/core/cron/jobs/outbox-summary/scan.ts',
  'src/core/cron/jobs/outbox-summary/write.ts',
  'src/core/cron/jobs/disk-monitor.ts',
  'src/core/cron/jobs/git-gc-weekly.ts',
  'src/core/memory/deep-dream.ts',
  'src/core/runtime/claw-config-schema.ts',
  'src/core/runtime/create-runtime.ts',
  'src/core/runtime/runtime.ts',
  'src/core/shadow-system/constants.ts',
  'src/core/shadow-system/spawn-shadow-subagent.ts',
  'src/core/shadow-system/system.ts',
  'src/core/shadow-system/tools/shadow.ts',
  'src/core/shadow-system/types.ts',
  'src/core/spawn-system/system.ts',
  'src/core/spawn-system/tools/spawn.ts',
  'src/core/status-service/forum-aggregators.ts',
  'src/core/status-service/forum-formatter.ts',
  'src/core/status-service/status-tool.ts',
  'src/core/subagent/agent.ts',
  'src/core/subagent/tools/done.ts',
  'src/core/summon-system/audit-events.ts',
  'src/core/summon-system/caller-types.ts',
  'src/core/summon-system/post-processors/contract-extract.ts',
  'src/core/summon-system/tools/ask-motion.ts',
  'src/core/summon-system/tools/summon.ts',
  // phase 553: claw-topology 子模块业主声明 motion claw 角色 + MOTION_CLAW_ID
  // 单源定义、合理 caller boundary（同 core/runtime/runtime.ts 模式）
  'src/core/claw-topology/agent-dir-resolver.ts',
  'src/core/claw-topology/agent-tools.ts',
  'src/core/claw-topology/index.ts',
  'src/core/claw-topology/motion-claw-id.ts',
  'src/core/claw-topology/topology.ts',
];

const BANNED_REEXPORTS = ['CallerType', 'DispatchCallerType', 'callerTypeToProfile'];

const ROLE_SET = new Set(BUSINESS_ROLES);

function isL1L4(filename) {
  return filename.includes('src/foundation/') || filename.includes('src/core/');
}

function isToolProtocol(filename) {
  return filename.includes('src/foundation/tool-protocol/');
}

function isAllowListed(filename) {
  return FOUNDATION_ALLOW_LIST_SUFFIXES.some((s) => filename.endsWith(s)) ||
    CORE_ALLOW_LIST_SUFFIXES.some((s) => filename.endsWith(s));
}

function kindOf(filename) {
  if (filename.includes('src/foundation/')) {
    return 'foundation/' + (filename.split('src/foundation/')[1] || 'unknown');
  }
  if (filename.includes('src/core/')) {
    return 'core/' + (filename.split('src/core/')[1] || 'unknown');
  }
  return 'unknown';
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'L1-L4 (foundation/ + core/) does not hold quoted business caller role literal nor MOTION_CLAW_ID identifier (M#5 + phase 117 + phase 1395)',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      businessLiteral:
        'Business role literal "{{role}}" detected in {{kind}}. L1-L4 (foundation/ + core/) is infra, must not preset business role (M#5 + phase 117).',
      motionClawIdIdentifier:
        '`MOTION_CLAW_ID` identifier in {{kind}}. L1-L4 must not hard-bind business concept (M#5 + phase 117 same family as business role literal).',
      callerTypeReexport:
        'foundation/tool-protocol/index.ts must not re-export "{{name}}" (CallerType is L4 business concept, M#5).',
    },
  },

  create(context) {
    const filename = context.filename || '';
    if (!isL1L4(filename)) return {};

    const strictTp = isToolProtocol(filename);
    const allowed = isAllowListed(filename);
    const kind = kindOf(filename);

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (!ROLE_SET.has(node.value)) return;

        // tool-protocol/ : strict, always report
        if (strictTp) {
          context.report({
            node,
            messageId: 'businessLiteral',
            data: { role: node.value, kind: 'foundation/tool-protocol' },
          });
          return;
        }

        // allow-list: skip
        if (allowed) return;

        context.report({
          node,
          messageId: 'businessLiteral',
          data: { role: node.value, kind },
        });
      },

      TemplateElement(node) {
        const v = node.value && node.value.cooked;
        if (typeof v !== 'string') return;
        if (!ROLE_SET.has(v)) return;
        if (strictTp) {
          context.report({
            node,
            messageId: 'businessLiteral',
            data: { role: v, kind: 'foundation/tool-protocol' },
          });
          return;
        }
        if (allowed) return;
        context.report({
          node,
          messageId: 'businessLiteral',
          data: { role: v, kind },
        });
      },

      // phase 384: MOTION_CLAW_ID identifier ban (mirrors phase 117 vitest invariant)
      Identifier(node) {
        if (node.name !== 'MOTION_CLAW_ID') return;
        if (strictTp) {
          context.report({
            node,
            messageId: 'motionClawIdIdentifier',
            data: { kind: 'foundation/tool-protocol' },
          });
          return;
        }
        if (allowed) return;
        context.report({
          node,
          messageId: 'motionClawIdIdentifier',
          data: { kind },
        });
      },

      // tool-protocol/index.ts must not re-export CallerType etc.
      ExportSpecifier(node) {
        if (!strictTp) return;
        const exported = node.exported && node.exported.name;
        if (BANNED_REEXPORTS.includes(exported)) {
          context.report({ node, messageId: 'callerTypeReexport', data: { name: exported } });
        }
      },
      ExportNamedDeclaration(node) {
        if (!strictTp) return;
        if (!node.declaration) return;
        // export type T = ... / export const T = ... / export function T(...) {}
        const decl = node.declaration;
        if (decl.type === 'TSTypeAliasDeclaration' || decl.type === 'VariableDeclaration' || decl.type === 'FunctionDeclaration') {
          const ids = decl.type === 'VariableDeclaration'
            ? decl.declarations.map((d) => d.id && d.id.name).filter(Boolean)
            : [decl.id && decl.id.name].filter(Boolean);
          for (const id of ids) {
            if (BANNED_REEXPORTS.includes(id)) {
              context.report({ node, messageId: 'callerTypeReexport', data: { name: id } });
            }
          }
        }
      },
    };
  },
};
