/**
 * phase 767 NEW / phase 1087 shadow async
 * shadow 工具入口，async/sync 双路径
 *
 * phase boundary refactoring: factory pattern — L4 turn state (systemPrompt,
 * tools, dialogMessages) injected via getTurnSnapshot callback instead of
 * reading from ExecContext (M#5: L2 doesn't know L4 semantics).
 */

import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import type { Message, ToolDefinition } from '../../../foundation/llm-provider/index.js';
import { runShadow } from '../system.js';
import { runSubagent as defaultRunSubagent } from '../../subagent/index.js';
import { SHADOW_AUDIT_EVENTS } from '../audit-events.js';
import { spawnShadowSubagent } from '../spawn-shadow-subagent.js';
import { stripIncompleteToolUse } from '../_helpers.js';
import { SHADOW_TOOL_NAME, SHADOW_CALLER_LABEL, SHADOW_DEFAULT_TIMEOUT_MS } from '../constants.js';

export function createShadowTool(deps: {
  getTurnSnapshot: () => {
    systemPrompt?: string;
    tools?: ToolDefinition[];
    messages?: Message[];
  } | Promise<{
    systemPrompt?: string;
    tools?: ToolDefinition[];
    messages?: Message[];
  }>;
  /** DI seam: optional runSubagent override (replaces vi.mock pattern) */
  runSubagent?: typeof defaultRunSubagent;
  taskSystem?: { schedule(kind: string, payload: Record<string, unknown>): Promise<string> };
}): Tool {
  return {
    name: SHADOW_TOOL_NAME,
    profiles: ['full'],
    group: 'shadow',
    description: 'Create a one-shot shadow of yourself with full context inheritance. ' +
      'By default the shadow executes asynchronously and results arrive via inbox. ' +
      'Set async=false for synchronous execution that blocks until the result is available inline. ' +
      'Use when you need an equally capable copy to handle a task without polluting your context window. ' +
      'You cannot call shadow from within shadow (no recursion).',
    schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task for the shadow to perform.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds (default: ${SHADOW_DEFAULT_TIMEOUT_MS}).`,
          minimum: 1,
        },
        maxSteps: {
          type: 'number',
          description: 'Maximum ReAct steps (default: subagent max_steps).',
          minimum: 1,
        },
        async: {
          type: 'boolean',
          description: 'true (default): async execution, result via inbox. false: sync execution, blocks until result available inline.',
        },
      },
      required: ['task'],
    },
    readonly: false,
    idempotent: false,
    defaultTimeoutMs: SHADOW_DEFAULT_TIMEOUT_MS,

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      // 防递归（D6 A ratify）
      if (ctx.callerLabel === SHADOW_CALLER_LABEL) {
        ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.RECURSION_REJECTED, String(ctx.clawId ?? 'unknown'));
        return {
          success: false,
          content: 'shadow is not callable from within a shadow (no recursion).',
          error: 'shadow_recursion_rejected',
        };
      }

      const task = String(args.task ?? '');
      if (!task) return { success: false, content: 'shadow: task is required', error: 'missing_task' };

      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : SHADOW_DEFAULT_TIMEOUT_MS;
      const maxSteps = typeof args.maxSteps === 'number' ? args.maxSteps : (ctx.subagentMaxSteps ?? ctx.maxSteps);
      const asyncMode = args.async === undefined ? true : Boolean(args.async);

      const { systemPrompt, tools, messages } = await deps.getTurnSnapshot();

      // 两路径共同：截掉当前消息末的 shadow tool_use（未配 tool_result）
      const mainMessages = stripIncompleteToolUse(messages);

      if (asyncMode) {
        const result = await spawnShadowSubagent({
          task,
          mainMessages: mainMessages ?? [],
          ctx,
          taskSystem: deps.taskSystem,
          originClawId: ctx.clawId,
          systemPrompt: systemPrompt ?? '',
          toolsForLLM: tools ?? [],
          timeoutMs,
          maxSteps,
        });
        if (!('taskId' in result)) return result;

        return {
          success: true,
          content: `Shadow queued. Task ID: ${result.taskId}. Result will be delivered to inbox when complete.`,
          metadata: { taskId: result.taskId, async: true },
        };
      }

      return runShadow({
        task,
        timeoutMs,
        maxSteps,
        ctx,
        mainMessages,
        turnSnapshot: { systemPrompt, tools, messages },
        runSubagent: deps.runSubagent,
      });
    },
  };
}


