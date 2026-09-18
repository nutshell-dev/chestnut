/**
 * phase 767 NEW / phase 1087 shadow async
 * shadow 工具入口，async/sync 双路径
 *
 * phase boundary refactoring: factory pattern — L4 turn state (systemPrompt,
 * tools, dialogMessages) injected via getTurnSnapshot callback instead of
 * reading from ExecContext (M#5: L2 doesn't know L4 semantics).
 *
 * phase 1865 (SH-D2): 三职责拆分——快照获取（extractSnapshot）/ 提交产 task（submitShadow）/
 * 同步执行跑至结果（runShadowSync）；工具面只做参数裁决与分发。三入口返回形状逐字段不变。
 */

import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import type { ToolDefinition } from '../../../foundation/llm-provider/index.js';
import type { Message } from '../../../foundation/dialog-store/index.js';
import { runShadow } from '../system.js';
import { runSubagent as defaultRunSubagent } from '../../subagent/index.js';
import { SHADOW_AUDIT_EVENTS } from '../audit-events.js';
import { spawnShadowSubagent } from '../spawn-shadow-subagent.js';
import { stripIncompleteToolUse } from '../_helpers.js';
import { SHADOW_TOOL_NAME, SHADOW_DEFAULT_TIMEOUT_MS } from '../constants.js';
import type { SubAgentTaskScheduler } from '../../async-task-system/index.js';

interface TurnSnapshot {
  systemPrompt?: string;
  tools?: ToolDefinition[];
  messages?: Message[];
}

/** 工具构造 deps（Assembly 注入面）。 */
export interface ShadowToolDeps {
  getTurnSnapshot: () => TurnSnapshot | Promise<TurnSnapshot>;
  /** DI seam: optional runSubagent override (replaces vi.mock pattern) */
  runSubagent?: typeof defaultRunSubagent;
  taskSystem?: SubAgentTaskScheduler;
  /** 同 daemon 内恒定的子代理步数上限（Assembly 从 config 注入） */
  subagentMaxSteps?: number;
  /** 允许递归调用。主 agent=true（默认），shadow registry=false */
  allowRecursion?: boolean;
}

/** 裁决后的单次调用参数（参数裁决留在 execute，三入口只消费）。 */
interface ShadowCallArgs {
  task: string;
  timeoutMs: number;
  maxSteps: number | undefined;
}

/** 快照面：turn 快照 + 剥离未配对 tool_use 尾条（两执行路径共用一个调用点）。 */
async function extractSnapshot(deps: ShadowToolDeps): Promise<TurnSnapshot & { mainMessages: Message[] | undefined }> {
  const { systemPrompt, tools, messages } = await deps.getTurnSnapshot();
  return { systemPrompt, tools, messages, mainMessages: stripIncompleteToolUse(messages) };
}

/** 提交（异步路径）：快照 → payload → spawnShadowSubagent → queued 回执。 */
async function submitShadow(deps: ShadowToolDeps, args: ShadowCallArgs, ctx: ExecContext): Promise<ToolResult> {
  const snapshot = await extractSnapshot(deps);

  const result = await spawnShadowSubagent({
    task: args.task,
    mainMessages: snapshot.mainMessages ?? [],
    ctx,
    taskSystem: deps.taskSystem,
    originClawId: ctx.clawId,
    systemPrompt: snapshot.systemPrompt ?? '',
    toolsForLLM: snapshot.tools ?? [],
    timeoutMs: args.timeoutMs,
    maxSteps: args.maxSteps,
  });
  if (!('taskId' in result)) return result;

  return {
    success: true,
    content: `Shadow queued. Task ID: ${result.taskId}. Result will be delivered to inbox when complete.`,
    metadata: { taskId: result.taskId, async: true },
  };
}

/** 同步执行（阻塞路径）：快照 → runShadow → inline 结果。 */
async function runShadowSync(deps: ShadowToolDeps, args: ShadowCallArgs, ctx: ExecContext): Promise<ToolResult> {
  const snapshot = await extractSnapshot(deps);

  return runShadow({
    task: args.task,
    timeoutMs: args.timeoutMs,
    maxSteps: args.maxSteps,
    ctx,
    mainMessages: snapshot.mainMessages,
    turnSnapshot: { systemPrompt: snapshot.systemPrompt, tools: snapshot.tools, messages: snapshot.messages },
    runSubagent: deps.runSubagent,
  });
}

export function createShadowTool(deps: ShadowToolDeps): Tool {
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

      const task = String(args.task ?? '');
      if (!task) return { success: false, content: 'shadow: task is required', error: 'missing_task' };

      const asyncMode = args.async === undefined ? true : Boolean(args.async);
      const callArgs: ShadowCallArgs = {
        task,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : SHADOW_DEFAULT_TIMEOUT_MS,
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : deps.subagentMaxSteps,
      };

      return asyncMode
        ? submitShadow(deps, callArgs, ctx)
        : runShadowSync(deps, callArgs, ctx);
    },
    allowRecursion: deps.allowRecursion ?? true,
    restrictedOverrides: { allowRecursion: false },
  };
  return tool;
}
