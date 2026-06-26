/**
 * spawn tool - Create and delegate tasks to subagents
 * 
 * This tool schedules a subagent task and returns immediately.
 * Results are delivered via inbox message when the subagent completes.
 */

import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import { runSpawnSync, type RunSpawnSyncOptions } from '../system.js';
import {
  resolveSpawnTemplate,
  DEFAULT_SPAWN_TEMPLATE,
  listSpawnTemplateNames,
} from '../templates.js';
import { SPAWN_AUDIT_EVENTS } from '../audit-events.js';

import { SHADOW_CALLER_LABEL } from '../../shadow-system/index.js';
import { SPAWN_DEFAULT_TIMEOUT_MS } from '../constants.js';

/**
 * Spawn tool implementation
 *
 * phase 763：从 async-task-system/tools/spawn.ts 迁至 spawn-system 模块（M#1 业务语义独立）。
 * phase 11：加 template 参数 / caller-side 预制 system prompt 选择 / 未知名 reject 不静默 fall back。
 * 直接写 tasks/queues/pending/ 文件，由 async-task-system watcher 异步调度。
 */
import { formatErr } from '../_helpers.js';
// phase 1490: tool description 字符串不再泄 DEFAULT_MAX_STEPS const 值到 LLM docs — agent-executor 自持默认值。
export const SPAWN_TOOL_NAME = 'spawn' as const;

export interface SpawnToolDeps {
  runSubagent?: RunSpawnSyncOptions['runSubagent'];
  taskSystem?: { schedule(kind: string, payload: Record<string, unknown>): Promise<string> };
  /** 创建链路的源头 clawId，同 daemon 内恒定（motion='motion'，clawA='clawA'） */
  originClawId?: string;
}

export function createSpawnTool(deps: SpawnToolDeps = {}): Tool {
  const { runSubagent, taskSystem } = deps;
  return {
    name: SPAWN_TOOL_NAME,
    profiles: ['full'],
    group: 'spawn',
    description: 'Create a subagent to handle a delegated task. ' +
      'By default the subagent executes asynchronously and results arrive via inbox. ' +
      'Set async=false for synchronous execution that blocks until the subagent completes and returns the result inline.',
    schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'The user intent / task goal for the subagent',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds (default: ${SPAWN_DEFAULT_TIMEOUT_MS})`,
        },
        maxSteps: {
          type: 'number',
          description: `Maximum number of ReAct steps the subagent can take (default: inherits caller's main loop maxSteps). Increase for complex multi-file tasks; decrease for simple lookups.`,
        },
        async: {
          type: 'boolean',
          description: 'true (default): async execution, returns immediately, result via inbox. false: sync execution, blocks until result is available inline.',
        },
        template: {
          type: 'string',
          description: "Named system prompt template for the subagent. 'default' (default) uses the standard subagent system prompt.",
        },
      },
      required: ['intent'],
    },
    readonly: false,
    idempotent: false,
    defaultTimeoutMs: SPAWN_DEFAULT_TIMEOUT_MS,

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const intent = String(args.intent);
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : SPAWN_DEFAULT_TIMEOUT_MS;
      const maxSteps = typeof args.maxSteps === 'number'
        ? args.maxSteps
        : (ctx.subagentMaxSteps ?? ctx.maxSteps);
      const asyncMode = args.async === undefined ? true : Boolean(args.async);
      const templateName = typeof args.template === 'string' ? args.template : DEFAULT_SPAWN_TEMPLATE;

      // shadow 防御（per shadow D6 A ratify）/ 先于 template resolve、保既有 reject 顺序
      if (ctx.callerLabel === SHADOW_CALLER_LABEL && asyncMode) {
        return {
          success: false,
          content: 'spawn from within shadow must use async=false. shadow has no async machinery — async-scheduled tasks would orphan to main inbox after shadow exits, unreachable from within shadow.',
          error: 'shadow_async_spawn_rejected',
        };
      }

      // template resolve（phase 11）/ 未知名 reject 不静默 fall back、留 audit
      const systemPrompt = resolveSpawnTemplate(templateName);
      if (systemPrompt === null) {
        const available = listSpawnTemplateNames().join(', ');
        const aw = ctx.auditWriter;
        aw?.write(
          SPAWN_AUDIT_EVENTS.TEMPLATE_UNKNOWN,
          aw.preview(templateName),
          available,
        );
        return {
          success: false,
          content: `[chestnut spawn] unknown template: '${templateName}'. Available: ${available}`,
          error: 'spawn_template_unknown',
        };
      }

      if (asyncMode) {
        if (!taskSystem) {
          return {
            success: false,
            content: '[chestnut spawn] task_system not available in execution context — async path requires AsyncTaskSystem injection',
            error: 'task_system_unavailable',
          };
        }
        const mainContextSnapshot = ctx.clawId && ctx.currentToolUseId
          ? { clawId: ctx.clawId, toolUseId: ctx.currentToolUseId }
          : undefined;
        try {
          const taskId = await taskSystem.schedule('subagent', {
            kind: 'subagent',
            mode: 'standard',
            intent,
            timeoutMs,
            maxSteps,
            systemPrompt,
            parentClawId: ctx.clawId,
            originClawId: deps.originClawId ?? ctx.clawId,
            callerType: 'subagent',
            mainContextSnapshot,
          });

          return {
            success: true,
            content: `Subagent created. Task ID: ${taskId}. Results will be delivered to inbox when complete.`,
            metadata: { taskId },
          };
        } catch (error) {
          const errorMsg = formatErr(error);
          const aw2 = ctx.auditWriter;
          aw2?.write(
            SPAWN_AUDIT_EVENTS.ASYNC_SCHEDULE_FAILED,
            aw2.preview(intent),
            errorMsg,
          );
          return { success: false, content: `Failed to create subagent: ${errorMsg}`, error: errorMsg };
        }
      }

      return runSpawnSync({ intent, timeoutMs, maxSteps, systemPrompt, ctx, runSubagent });
    },
  };
}

// module-level default 实例向后兼容 assembly 注册
export const spawnTool: Tool = createSpawnTool();
