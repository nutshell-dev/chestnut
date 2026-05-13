/**
 * phase 767 NEW
 * shadow 工具入口，调 runShadow 同步阻塞
 */

import type { Tool, ToolResult, ExecContext } from '../../../foundation/tool-protocol/index.js';
import { SHADOW_TOOL_NAME } from '../../../foundation/tools/tool-names.js';
import { runShadow } from '../system.js';
import { SHADOW_AUDIT_EVENTS } from '../audit-events.js';

export { SHADOW_TOOL_NAME };

export const shadowTool: Tool = {
  name: SHADOW_TOOL_NAME,
  description: 'Create a one-shot shadow of yourself with full context inheritance. ' +
    'Shadow runs synchronously and returns its result inline. ' +
    'Use when you need an equally capable copy to handle a task without polluting your context window. ' +
    'Specify form: A (full inheritance with tool_result synthesis) or B (trimmed prefix with user message). ' +
    'You cannot call shadow from within shadow (no recursion).',
  schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task for the shadow to perform.',
      },
      form: {
        type: 'string',
        enum: ['A', 'B'],
        description: 'Form A: full session inheritance with synthetic tool_result. Form B: prefix trimmed before duplicate tool_use with fresh user message instruction. A/B testing required by shadow design.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 300000).',
      },
      maxSteps: {
        type: 'number',
        description: 'Maximum ReAct steps (default: subagent max_steps).',
      },
    },
    required: ['task', 'form'],
  },
  readonly: false,
  idempotent: false,

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
    const form = args.form === 'A' || args.form === 'B' ? args.form : null;
    if (!task) return { success: false, content: 'shadow: task is required', error: 'missing_task' };
    if (!form) return { success: false, content: "shadow: form must be 'A' or 'B'", error: 'missing_form' };

    return runShadow({
      task, form,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
      ctx,
    });
  },
};
