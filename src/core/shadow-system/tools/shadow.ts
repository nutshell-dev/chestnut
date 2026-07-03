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
import type { StreamLog } from '../../../foundation/stream/types.js';
import { runShadow } from '../system.js';
import { runSubagent as defaultRunSubagent } from '../../subagent/index.js';
import { SHADOW_AUDIT_EVENTS } from '../audit-events.js';
import { spawnShadowSubagent } from '../spawn-shadow-subagent.js';
import { stripIncompleteToolUse } from '../_helpers.js';
import { SHADOW_TOOL_NAME, SHADOW_DEFAULT_TIMEOUT_MS } from '../constants.js';

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
  /** 同 daemon 内恒定的子代理步数上限（Assembly 从 config 注入） */
  subagentMaxSteps?: number;
  /** sync shadow 写 task_started 到主 stream，viewport 可读取 shadow 子代理事件 */
  streamLog?: StreamLog;
  /** 允许递归调用。主 agent=true（默认），shadow registry=false */
  allowRecursion?: boolean;
}): Tool {
  const tool: Tool & { allowRecursion?: boolean } = {
    name: SHADOW_TOOL_NAME,
    profiles: ['full'],
    description: 'Branch your context to handle a task without polluting the main conversation. ' +
      'Your identity and conversation history are preserved. Only the final result ' +
      'is returned. Cannot be called from within another shadow (no recursion).',
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

    async execute(this: Tool & { allowRecursion?: boolean }, args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      // 防递归（D6 A ratify）：DI 注入替代 ctx.callerLabel
      if (this.allowRecursion === false) {
        ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.RECURSION_REJECTED, String(ctx.clawId ?? 'unknown'));
        return {
          success: false,
          content: 'shadow is not callable from within a shadow (no recursion).',
          error: 'shadow_recursion_rejected',
        };
      }

      const shadowMode = process.env.CHESTNUT_SHADOW_V1 === '1' ? 'v1' : 'v2';
      const asyncMode = args.async === undefined ? true : Boolean(args.async);

      // V2 async → 报错（下轮实现）
      if (shadowMode === 'v2' && asyncMode) {
        return {
          success: false,
          content: 'async shadow not yet supported in V2. Use async=false.',
          error: 'async_not_supported_in_v2',
        };
      }

      const task = String(args.task ?? '');
      if (!task) return { success: false, content: 'shadow: task is required', error: 'missing_task' };

      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : SHADOW_DEFAULT_TIMEOUT_MS;
      const maxSteps = typeof args.maxSteps === 'number' ? args.maxSteps : deps.subagentMaxSteps;

      const { systemPrompt, tools, messages } = await deps.getTurnSnapshot();

      if (shadowMode === 'v2') {
        // V2 sync：保留完整 messages（含 shadow() tool_use），追加 synthetic tool_result
        const syntheticToolResult: Message = {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: ctx.currentToolUseId!,
            content: 'Shadow mode started. Continue from here. '
              + 'Call done() to return results to the main conversation.',
          }],
        };

        return runShadow({
          task,
          timeoutMs,
          maxSteps,
          ctx,
          mainMessages: [...messages!, syntheticToolResult],
          turnSnapshot: { systemPrompt, tools, messages },
          runSubagent: deps.runSubagent,
          mode: 'v2',
          streamLog: deps.streamLog,
        });
      }

      // V1：现有行为
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
          mode: 'v1',
        });
        if (!('taskId' in result)) return result;

        return {
          success: true,
          content: `Shadow queued. Task ID: ${result.taskId}. Result will be delivered to inbox when complete.`,
          metadata: { taskId: result.taskId, async: true },
        };
      }

      // V1 sync
      return runShadow({
        task,
        timeoutMs,
        maxSteps,
        ctx,
        mainMessages,
        turnSnapshot: { systemPrompt, tools, messages },
        runSubagent: deps.runSubagent,
        mode: 'v1',
      });
    },
    allowRecursion: deps.allowRecursion ?? true,
  };
  return tool;
}


