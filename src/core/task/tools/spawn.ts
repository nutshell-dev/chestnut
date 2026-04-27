/**
 * spawn tool - Create and delegate tasks to subagents
 * 
 * This tool schedules a subagent task and returns immediately.
 * Results are delivered via inbox message when the subagent completes.
 */

import type { Tool, ToolResult, ExecContext } from '../../tools/executor.js';

import { SPAWN_DEFAULT_TIMEOUT_S, DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_MAX_STEPS } from '../../../constants.js';
import type { Message } from '../../../types/message.js';
import { TOOL_PROFILES } from '../../tools/profiles.js';
import { writePendingSubagentTaskFile } from './_pending-task-writer.js';

/**
 * Spawn tool implementation
 *
 * phase163: 直接写 tasks/pending/ 文件，由 watcher 异步调度。
 * 不再依赖 TaskSystem 实例。
 */
import { SPAWN_TOOL_NAME } from '../../tools/tool-names.js';
export { SPAWN_TOOL_NAME };

export const spawnTool: Tool = {
  name: SPAWN_TOOL_NAME,
  description: 'Create a subagent to handle a delegated task. The subagent will execute independently and return results via inbox when complete.',
  schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task description for the subagent',
      },

      tools: {
        type: 'array',
        items: { type: 'string' },
        description: `Tools available to the subagent (default: ${TOOL_PROFILES['subagent'].join(', ')})`,
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds (default: 300)',
      },
      maxSteps: {
        type: 'number',
        description: 'Maximum number of ReAct steps the subagent can take (default: 100). Increase for complex multi-file tasks; decrease for simple lookups.',
      },
      idleTimeoutMs: {
        type: 'number',
        description: 'LLM idle timeout in milliseconds (default: 60000). Abort if no token output for this duration.',
      },
      messages: {
        type: 'array',
        description: 'Prior conversation messages to continue from. prompt will be appended as a new user message.',
        items: { type: 'object' },
      },
      systemPrompt: {
        type: 'string',
        description: 'Custom system prompt for the subagent (optional, for internal system use)',
      },
    },
    required: ['prompt'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const prompt = String(args.prompt);
    const messages = (() => {
      if (!Array.isArray(args.messages)) return undefined;
      for (const m of args.messages) {
        if (
          m === null ||
          typeof m !== 'object' ||
          typeof (m as Record<string, unknown>).role !== 'string' ||
          (m as Record<string, unknown>).content === undefined
        ) {
          return null;  // sentinel: 校验失败
        }
      }
      return args.messages as Message[];
    })();

    if (messages === null) {
      return {
        success: false,
        content: 'Invalid messages parameter: each element must be an object with string role and content.',
        error: 'Invalid messages',
      };
    }

    const tools = Array.isArray(args.tools) ? (args.tools as string[]) : TOOL_PROFILES['subagent'];
    const timeout = typeof args.timeout === 'number' ? args.timeout : SPAWN_DEFAULT_TIMEOUT_S;
    const maxSteps = typeof args.maxSteps === 'number' 
      ? args.maxSteps 
      : (ctx.subagentMaxSteps ?? ctx.maxSteps ?? DEFAULT_MAX_STEPS);
    const idleTimeoutMs = typeof args.idleTimeoutMs === 'number'
      ? args.idleTimeoutMs
      : DEFAULT_LLM_IDLE_TIMEOUT_MS;

    try {
      const taskId = await writePendingSubagentTaskFile(ctx.fs, ctx.auditWriter, {
        kind: 'subagent',
        prompt,
        messages,
        tools,
        timeout,
        maxSteps,
        idleTimeoutMs,
        parentClawId: ctx.clawId,
        originClawId: ctx.originClawId ?? ctx.clawId,
        systemPrompt: typeof args.systemPrompt === 'string' ? args.systemPrompt : undefined,
        callerType: 'subagent',
      });

      return {
        success: true,
        content: `Subagent created. Task ID: ${taskId}. Results will be delivered to inbox when complete.`,
        metadata: { taskId },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: `Failed to create subagent: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
