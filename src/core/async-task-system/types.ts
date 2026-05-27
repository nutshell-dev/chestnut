/**
 * @module L4.AsyncTaskSystem.Types
 * Hub-level type exports to break circular imports within async-task-system.
 * Extracted in phase 1314 (cluster #3 of 5 cleanup roadmap).
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { OutboxWriter, InboxWriter } from '../../foundation/messaging/index.js';
import type { ContractSystem } from '../contract/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { StreamLog } from '../../foundation/stream/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/permission.js';
import type { CallerType } from '../caller-types.js';
import type { ClawId, TaskId } from '../../foundation/identity/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';




export interface AsyncTaskSystemOptions {
  maxConcurrent?: number;
  auditWriter: AuditLog;
  retryBaseDelayMs?: number;
  parentStreamLog?: StreamLog;

  llm: LLMOrchestrator;
  contractManager: ContractSystem;
  outboxWriter: OutboxWriter;
  /** Motion inbox for overflow notification (optional, backward compat) */
  motionInbox?: InboxWriter;
  // main dialog store ref for subagent context restoration
  mainDialogStore?: DialogStore;
  registry: ToolRegistry;     // NEW: caller 注入填充好的 registry / Assembly own 装配
  /** Tool-level wall-clock timeout inherited from globalConfig.tool_timeout_ms (phase 1029 / F-2) */
  toolTimeoutMs?: number;
  permissionChecker?: PermissionChecker;
  fsFactory: (baseDir: string) => FileSystem;
  // NEW phase 1369: AskMotionTool factory inject (per phase 619 caller DIP enforce template / cut async-task→summon reverse)
  askMotionToolFactory: (llm: LLMOrchestrator, motionDialogStore: DialogStore) => import('../../foundation/tools/index.js').Tool;
}


interface CommonSubAgentTaskFields {
  kind: 'subagent';
  id: TaskId;
  timeoutMs: number;
  maxSteps: number;
  parentClawId: string;
  createdAt: string;
  callerType?: CallerType;
  originClawId?: string;                   // 创建链路源头，传给子 SubAgent
  /**
   * Motion clawDir（仅 mining summon / phase 713 reframe）
   * subagent-executor 据此构造 motionDialogStore 注入 AskMotionTool
   * ask_motion.execute 内部 read motionDialogStore.load() 拿 summon 时刻 dialog snapshot
   * 全然一致性 reuse Motion runtime 实然 dialog snapshot（per phase 709 design）
   */
  motionClawDir?: string;
  postProcessor?: string;            // 声明式 post-processor 名称（registry lookup）
  mainContextSnapshot?: { clawId: ClawId; toolUseId: ToolUseId };  // NEW marker mode
  systemPrompt?: string;                 // phase 546 internal field：caller-side specialized system prompt（agent 不可见 / 与 phase 470 砍 agent-facing spawn schema 不冲突 / fall-back DEFAULT_SUBAGENT_SYSTEM_PROMPT）
  // phase 1087：shadow async 上下文快照字段
  isShadow?: boolean;
  shadowSystemPrompt?: string;
  shadowToolsForLLM?: ToolDefinition[];
}

export type SubAgentTask =
  | (CommonSubAgentTaskFields & { mode: 'standard'; intent: string; shadowMessages?: undefined; intentPreview?: undefined })
  | (CommonSubAgentTaskFields & { mode: 'shadow'; intent?: undefined; shadowMessages: Message[]; intentPreview: string });

export interface ToolTask {
  kind: 'tool';
  id: TaskId;
  toolName: string;
  args: Record<string, unknown>;        // fs-persistable / 替代 callback closure
  parentClawDir: string;                // caller clawDir / ctx 重建用
  parentClawId: string;
  createdAt: string;
  isIdempotent: boolean;  // Determines if retry is allowed
  maxRetries: number;     // Max retry attempts (default 2)
  retryCount: number;     // Current retry count (initial 0)
  callerType?: CallerType;  // 决定 inbox 消息 from 字段
  toolUseId?: ToolUseId;   // 对应 LLM tool_use block id，用于 tool_async_result
  /** phase 858：sourced from ExecContext.isShadow at schedule time */
  isShadow?: boolean;
}

