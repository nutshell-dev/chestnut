import type { ExecContext } from '../../foundation/tools/index.js';
import type { Message, ToolDefinition } from '../../foundation/llm-provider/types.js';
import type { TaskId } from '../async-task-system/types.js';


export interface SpawnShadowSubagentOptions {
  /** 子代理任务体（嵌入 SHADOW INSTRUCTION + 不再单独 push prompt） */
  task: string;
  /** caller 已 strip incomplete tool_use 后的 motion dialog */
  mainMessages: Message[];
  ctx: ExecContext;
  /** motion 当前 turn 快照 system prompt（shadow KV cache 命中） */
  systemPrompt: string;
  /** motion 完整工具列表（shadow 继承全工具集） */
  toolsForLLM: ToolDefinition[];
  /** 默认 300_000 ms */
  timeoutMs?: number;
  maxSteps?: number;
  idleTimeoutMs?: number;
  /** optional post-processor 名（summon 用 'summon-contract-extract'） */
  postProcessor?: string;
  /** shadow id 前缀，默认 'shadow'、summon 传 'summon' */
  shadowIdPrefix?: string;
}

export interface SpawnShadowSubagentResult {
  taskId: TaskId;
  shadowId: string;
}
