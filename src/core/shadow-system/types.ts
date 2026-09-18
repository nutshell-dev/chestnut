import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import type { SubAgentTaskScheduler, TaskId } from '../async-task-system/index.js';


export interface SpawnShadowSubagentOptions {
  /** 子代理任务体（嵌入 SHADOW INSTRUCTION + 不再单独 push prompt） */
  task: string;
  /** caller 已 strip incomplete tool_use 后的 motion dialog */
  mainMessages: Message[];
  ctx: ExecContext;
  taskSystem?: SubAgentTaskScheduler;
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
}

export type SpawnShadowSubagentResult =
  | { taskId: TaskId; shadowId: string }
  | { success: false; content: string; error: string };

/**
 * phase 1865 (SH-D3)：单一身份上下文（执行 owner 生成——async 路径经 buildShadowPayload /
 * sync 路径经 runShadow）。消费面的 isShadow 事实由本单源派生，不再各自硬编码。
 */
export interface ShadowIdentity {
  readonly shadowId: string;
  readonly originClawId?: string;
  /** 身份事实：本执行是 shadow（恒 true；schedule payload 派生自此）。 */
  readonly isShadow: true;
}

/**
 * phase 1865 (SH-D1)：shadow 执行 payload 契约（owner 定义；构造经 {@link buildShadowPayload}）。
 * ATS 侧 opaque 消费与字段形态迁移归 phase 1863 E。
 */
export interface ShadowExecutorPayload {
  /** shadow 视角完整 system prompt（KV cache 对齐 main）。 */
  readonly systemPrompt: string;
  /** shadow 视角消息序列（synthesizeFormB 产物）。 */
  readonly messages: Message[];
  /** shadow 继承的工具全集。 */
  readonly toolsForLLM: ToolDefinition[];
  /** 身份事实（单源：{@link ShadowIdentity}）。 */
  readonly identity: ShadowIdentity;
  /** 执行预算（Assembly/SubAgent 注入面——phase 1865 Step H 对齐）。 */
  readonly budget: {
    readonly timeoutMs?: number;
    readonly maxSteps?: number;
    readonly idleTimeoutMs?: number;
  };
  /** 结果处理（postProcessor 名——business adapter 面）。 */
  readonly postProcessor?: string;
}
