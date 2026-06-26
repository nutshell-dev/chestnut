import type { ExecContext } from '../../foundation/tools/index.js';
import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { TaskId } from '../async-task-system/types.js';
import type { SummonDecisionMetadata } from '../async-task-system/index.js';


export interface SpawnShadowSubagentOptions {
  /** 子代理任务体（嵌入 SHADOW INSTRUCTION + 不再单独 push prompt） */
  task: string;
  /** caller 已 strip incomplete tool_use 后的 motion dialog */
  mainMessages: Message[];
  ctx: ExecContext;
  taskSystem?: { schedule(kind: string, payload: Record<string, unknown>): Promise<string> };
  /** 创建链路的源头 clawId，同 daemon 内恒定 */
  originClawId?: string;
  /** motion 当前 turn 快照 system prompt（shadow KV cache 命中） */
  systemPrompt: string;
  /** motion 完整工具列表（shadow 继承全工具集） */
  toolsForLLM: ToolDefinition[];
  /** 默认值见 {@link SHADOW_DEFAULT_TIMEOUT_MS} */
  timeoutMs?: number;
  maxSteps?: number;
  idleTimeoutMs?: number;
  /** optional post-processor 名（summon 用 'summon-contract-extract'） */
  postProcessor?: string;
  /** shadow id 前缀，默认 'shadow'、summon 传 'summon' */
  shadowIdPrefix?: string;
  /** phase 281: summon decision 内嵌 metadata，随 task lifecycle 同步 */
  summonDecision?: SummonDecisionMetadata;
}

export type SpawnShadowSubagentResult =
  | { taskId: TaskId; shadowId: string }
  | { success: false; content: string; error: string };
