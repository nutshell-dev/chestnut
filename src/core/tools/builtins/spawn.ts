/**
 * spawn tool - Create and delegate tasks to subagents
 * 
 * This tool schedules a subagent task and returns immediately.
 * Results are delivered via inbox message when the subagent completes.
 */

import type { ITool, ToolResult, ExecContext } from '../executor.js';
import type { TaskSystem } from '../../task/system.js';
import type { StreamSink } from '../../../foundation/stream/types.js';
import { SPAWN_DEFAULT_TIMEOUT_S, DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_MAX_STEPS } from '../../../constants.js';
import type { Message } from '../../../types/message.js';
import { TOOL_PROFILES } from '../profiles.js';

/**
 * Schedule a subagent and write task_started to the stream.
 * Shared by spawn tool and daemon.ts (retrospective scheduling).
 */
export async function scheduleSubAgentWithTracking(
  taskSystem: TaskSystem,
  streamWriter: StreamSink,
  args: {
    prompt: string;
    messages?: Message[];
    tools?: string[];
    timeout?: number;
    maxSteps?: number;
    idleTimeoutMs?: number;
    parentClawId: string;
    originClawId: string;
    systemPrompt?: string;
    silent?: boolean;   // true = 不在 viewport 显示 ReAct 过程
  }
): Promise<string> {
  const taskId = await taskSystem.scheduleSubAgent({
    kind: 'subagent',
    prompt: args.prompt,
    messages: args.messages,
    tools: args.tools ?? TOOL_PROFILES['subagent'],
    timeout: args.timeout ?? SPAWN_DEFAULT_TIMEOUT_S,
    maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
    idleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS,
    parentClawId: args.parentClawId,
    originClawId: args.originClawId,
    systemPrompt: args.systemPrompt,
  });

  streamWriter.write({
    ts: Date.now(),
    type: 'task_started',
    taskId,
    callerType: 'subagent',
    silent: args.silent ?? false,
  });

  return taskId;
}

/**
 * Spawn tool implementation
 * 
 * Requires taskSystem to be injected before use.
 */
export const spawnTool: ITool = {
  name: 'spawn',
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
    const taskSystem = ctx.taskSystem;
    
    if (!taskSystem) {
      return {
        success: false,
        content: 'TaskSystem not available. Spawn tool requires TaskSystem to be injected.',
        error: 'TaskSystem not configured',
      };
    }

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
      const taskId = await scheduleSubAgentWithTracking(
        taskSystem,
        ctx.parentStreamWriter ?? { write: () => {} },
        {
          prompt,
          messages,
          tools,
          timeout,
          maxSteps,
          idleTimeoutMs,
          parentClawId: ctx.clawId,
          originClawId: ctx.originClawId ?? ctx.clawId,
          systemPrompt: typeof args.systemPrompt === 'string' ? args.systemPrompt : undefined,
        }
      );

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
