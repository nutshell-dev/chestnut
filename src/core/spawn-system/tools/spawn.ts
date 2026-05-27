/**
 * spawn tool - Create and delegate tasks to subagents
 * 
 * This tool schedules a subagent task and returns immediately.
 * Results are delivered via inbox message when the subagent completes.
 */

import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import { runSpawnSync } from '../system.js';

/**
 * Spawn tool implementation
 *
 * phase 763：从 async-task-system/tools/spawn.ts 迁至 spawn-system 模块（M#1 业务语义独立）。
 * 直接写 tasks/queues/pending/ 文件，由 async-task-system watcher 异步调度。
 */
import { formatErr } from '../_helpers.js';
import { DEFAULT_MAX_STEPS } from '../../agent-executor/index.js';
export const SPAWN_TOOL_NAME = 'spawn' as const;

export const spawnTool: Tool = {
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
        description: 'Timeout in milliseconds (default: 60000)',
      },
      maxSteps: {
        type: 'number',
        description: `Maximum number of ReAct steps the subagent can take (default: inherits caller main loop maxSteps, typically DEFAULT_MAX_STEPS = ${DEFAULT_MAX_STEPS}). Increase for complex multi-file tasks; decrease for simple lookups.`,
      },
      async: {
        type: 'boolean',
        description: 'true (default): async execution, returns immediately, result via inbox. false: sync execution, blocks until result is available inline.',
      },
    },
    required: ['intent'],
  },
  readonly: false,
  idempotent: false,
  defaultTimeoutMs: 60_000,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const intent = String(args.intent);
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 60_000;
    const maxSteps = typeof args.maxSteps === 'number'
      ? args.maxSteps
      : (ctx.subagentMaxSteps ?? ctx.maxSteps);
    const asyncMode = args.async === undefined ? true : Boolean(args.async);

    // shadow 防御（per shadow D6 A ratify）
    if (ctx.isShadow && asyncMode) {
      return {
        success: false,
        content: 'spawn from within shadow must use async=false. shadow has no async machinery — async-scheduled tasks would orphan to main inbox after shadow exits, unreachable from within shadow.',
        error: 'shadow_async_spawn_rejected',
      };
    }

    if (asyncMode) {
      // 既有 async 路径，0 改
      const mainContextSnapshot = ctx.clawId && ctx.currentToolUseId
        ? { clawId: ctx.clawId, toolUseId: ctx.currentToolUseId }
        : undefined;
      try {
        const taskId = await ctx.taskSystem!.schedule('subagent', {
          kind: 'subagent',
          mode: 'standard',
          intent,
          timeoutMs,
          maxSteps,
          parentClawId: ctx.clawId,
          originClawId: ctx.originClawId ?? ctx.clawId,
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
        return { success: false, content: `Failed to create subagent: ${errorMsg}`, error: errorMsg };
      }
    }

    // NEW sync 路径
    return runSpawnSync({ intent, timeoutMs, maxSteps, ctx });
  },
};
