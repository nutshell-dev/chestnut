/**
 * ask_caller tool - Subagent asks parent claw about its context at spawn time
 *
 * Uses DialogStore.restorePrefix(marker) to reconstruct main context and
 * queries a LLM clone for clarification.
 */

import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import { MarkerNotFoundError } from '../../../foundation/dialog-store/index.js';
import type { DialogStore } from '../../../foundation/dialog-store/index.js';

export const ASK_CALLER_TOOL_NAME = 'ask_caller';

export function createAskCallerTool(deps: {
  mainDialogStore?: DialogStore;
  mainContextSnapshot?: { clawId: string; toolUseId: string };
}): Tool {
  const { mainDialogStore, mainContextSnapshot } = deps;

  return {
    name: ASK_CALLER_TOOL_NAME,
    description: 'Ask the parent claw a question about its context at the time of spawn. Useful when you need clarification on intent or context that was not captured in the spawn intent.',
    schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the parent claw' },
      },
      required: ['question'],
    },
    readonly: true,
    idempotent: false,

    async execute(args: Record<string, unknown>, _ctx: ExecContext): Promise<ToolResult> {
      const question = String(args.question ?? '');
      if (!question) {
        return { success: false, content: 'ask_caller: question is required', error: 'missing question' };
      }
      if (!mainDialogStore || !mainContextSnapshot) {
        return {
          success: false,
          content: 'ask_caller unavailable: parent context not available (this tool requires subagent profile + main context capture)',
          error: 'no main context',
        };
      }
      try {
        const restored = await mainDialogStore.restorePrefix(mainContextSnapshot);
        // LLM clone call setup
        // - system: restored.systemPrompt + ask_caller wrapper instruction
        // - messages: restored.messages + { role: 'user', content: question }
        // - 调 LLM (经 ctx.llm or 类似)
        // 实施期 derive: LLM call 的具体 wrapper / 见 modules/l4_task_system.md §10.2 ask_caller workflow

        // PLACEHOLDER: caller 实施期填 LLM call
        const cloneResponseContent = '<TODO: LLM clone call wrapper / per §10.2>';

        return { success: true, content: cloneResponseContent };
      } catch (err) {
        if (err instanceof MarkerNotFoundError) {
          return {
            success: false,
            content: `ask_caller: marker not found (toolUseId=${mainContextSnapshot.toolUseId})`,
            error: 'marker not found',
          };
        }
        throw err;
      }
    },
  };
}
