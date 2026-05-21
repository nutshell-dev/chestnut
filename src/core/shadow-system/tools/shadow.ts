/**
 * phase 767 NEW / phase 1087 shadow async
 * shadow 工具入口，async/sync 双路径
 */

import { randomUUID } from 'crypto';
import type { Tool, ToolResult, ExecContext } from '../../../foundation/tool-protocol/index.js';
import type { Message } from '../../../foundation/llm-provider/types.js';
import { SHADOW_TOOL_NAME } from '../../../foundation/tools/tool-names.js';
import { runShadow } from '../system.js';
import { SHADOW_AUDIT_EVENTS } from '../audit-events.js';
import { writePendingSubagentTaskFile } from '../../async-task-system/index.js';
import { synthesizeFormB } from '../_helpers.js';

export { SHADOW_TOOL_NAME };

/** Strip trailing incomplete assistant message so shadow LLM doesn't see unpaired tool_uses */
function stripIncompleteToolUse(msgs: Message[] | undefined): Message[] | undefined {
  if (!msgs || msgs.length === 0) return msgs;
  const last = msgs[msgs.length - 1];
  if (last.role === 'assistant' && Array.isArray(last.content)) {
    if (last.content.some((block: unknown) => (block as { type?: string })?.type === 'tool_use')) {
      return msgs.slice(0, -1);
    }
  }
  return msgs;
}

export const shadowTool: Tool = {
  name: SHADOW_TOOL_NAME,
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
        description: 'Timeout in milliseconds (default: 300000).',
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
  defaultTimeoutMs: 300_000,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    // 防递归（D6 A ratify）
    if (ctx.isShadow) {
      ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.RECURSION_REJECTED, String(ctx.clawId ?? 'unknown'));
      return {
        success: false,
        content: 'shadow is not callable from within a shadow (no recursion).',
        error: 'shadow_recursion_rejected',
      };
    }

    const task = String(args.task ?? '');
    if (!task) return { success: false, content: 'shadow: task is required', error: 'missing_task' };

    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 300_000;
    const maxSteps = typeof args.maxSteps === 'number' ? args.maxSteps : (ctx.subagentMaxSteps ?? ctx.maxSteps);
    const asyncMode = args.async === undefined ? true : Boolean(args.async);

    // 两路径共同：截掉当前消息末的 shadow tool_use（未配 tool_result）
    // sync 的 runShadow 用此值 / async 存到 task
    const mainMessages = stripIncompleteToolUse(ctx.dialogMessages);

    if (asyncMode) {
      // 合成 shadow instruction（sync 路径在 runShadow 内做，async 在此做）
      const shadowId = `shadow-${randomUUID().slice(0, 8)}`;
      const instructionArgs = {
        shadowId,
        spawnedAt: new Date().toISOString(),
        spawnedByClawId: ctx.clawId,
        toolUseId: ctx.currentToolUseId ?? '',
        task,
      };
      const synthesized = synthesizeFormB({ mainMessagesBeforeMarker: mainMessages ?? [], instructionArgs });

      const taskId = await writePendingSubagentTaskFile(ctx.fs, ctx.auditWriter, {
        kind: 'subagent',
        intent: task,
        timeoutMs,
        maxSteps,
        parentClawId: ctx.clawId,
        originClawId: ctx.originClawId ?? ctx.clawId,
        callerType: 'shadow',
        isShadow: true,
        shadowMessages: synthesized,
        shadowSystemPrompt: ctx.systemPromptForLLM,
        shadowToolsForLLM: ctx.toolsForLLM,
      });
      return {
        success: true,
        content: `Shadow queued. Task ID: ${taskId}. Result will be delivered to inbox when complete.`,
        metadata: { taskId, async: true },
      };
    }

    return runShadow({
      task,
      timeoutMs,
      maxSteps,
      ctx,
      mainMessages,
    });
  },
};
