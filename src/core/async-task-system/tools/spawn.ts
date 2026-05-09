/**
 * spawn tool - Create and delegate tasks to subagents
 * 
 * This tool schedules a subagent task and returns immediately.
 * Results are delivered via inbox message when the subagent completes.
 */

import type { Tool, ToolResult, ExecContext } from '../../../foundation/tool-protocol/index.js';

import { SPAWN_DEFAULT_TIMEOUT_S, DEFAULT_MAX_STEPS } from '../../../constants.js';
import { writePendingSubagentTaskFile } from './_pending-task-writer.js';

/**
 * Spawn tool implementation
 *
 * phase163: 直接写 tasks/queues/pending/ 文件（phase 510 加 queues/ 层），由 watcher 异步调度。
 * 不再依赖 AsyncTaskSystem 实例。
 */
import { SPAWN_TOOL_NAME } from '../../../foundation/tools/tool-names.js';
import { formatErr } from '../_helpers.js';
export { SPAWN_TOOL_NAME };

export const spawnTool: Tool = {
  name: SPAWN_TOOL_NAME,
  description: 'Create a subagent to handle a delegated task. The subagent will execute independently and return results via inbox when complete.',
  schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'The user intent / task goal for the subagent (subagent uses ask_caller to fetch main context if needed)',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 300000)',
      },
      maxSteps: {
        type: 'number',
        description: 'Maximum number of ReAct steps the subagent can take (default: 100). Increase for complex multi-file tasks; decrease for simple lookups.',
      },
    },
    required: ['intent'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const intent = String(args.intent);
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : SPAWN_DEFAULT_TIMEOUT_S * 1000;
    const maxSteps = typeof args.maxSteps === 'number'
      ? args.maxSteps
      : (ctx.subagentMaxSteps ?? ctx.maxSteps ?? DEFAULT_MAX_STEPS);

    // 装配 mainContextSnapshot from ctx.currentToolUseId
    const mainContextSnapshot = ctx.clawId && ctx.currentToolUseId
      ? { clawId: ctx.clawId, toolUseId: ctx.currentToolUseId }
      : undefined;

    try {
      const taskId = await writePendingSubagentTaskFile(ctx.fs, ctx.auditWriter, {
        kind: 'subagent',
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
      return {
        success: false,
        content: `Failed to create subagent: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
