/**
 * @module L5.Runtime.Types
 * Runtime interface types — 1:1 保 runtime.ts:47-126 body
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Snapshot } from '../../foundation/snapshot/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import type { InboxReader, OutboxWriter, MessageFormatterRegistry } from '../../foundation/messaging/index.js';
import type { MotionGuidanceRegistry } from '../../assembly/guidance/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { IToolExecutor } from '../../foundation/tools/index.js';
import type { ContextInjector } from '../dialog/index.js';
import type { SkillSystem } from '../../foundation/skill-system/index.js';
import type { ContractSystem } from '../contract/index.js';
import type { AsyncTaskSystem } from '../async-task-system/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/permission.js';

import type { InboxMessage } from '../../foundation/messaging/types.js';
import type { ToolProfile } from '../../foundation/tool-protocol/index.js';
import type { ClawId, ClawforumRoot } from '../../foundation/identity/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';
import { type ClawDir } from '../../foundation/identity/index.js';



/** 1:1 保 runtime.ts:47-72 body */
export interface RuntimeDependencies {
  // === L1 ===
  readonly systemFs: FileSystem;

  // === L2 ===
  readonly auditWriter: AuditLog;
  readonly snapshot: Snapshot;
  readonly sessionManager: DialogStore;
  readonly inboxReader: InboxReader;
  readonly outboxWriter: OutboxWriter;

  // === L3-L5 ===
  readonly llm: LLMOrchestrator;
  readonly toolRegistry: ToolRegistry;
  readonly toolExecutor: IToolExecutor;
  readonly contractManager: ContractSystem;
  readonly taskSystem: AsyncTaskSystem;
  readonly skillRegistry: SkillSystem;

  // === L4 (phase 1273) ===
  readonly permissionChecker: PermissionChecker;  // required / 编译期 enforce ML#9

  // phase 1283: fsFactory inject (ML#3 file I/O resource unique ownership)
  readonly fsFactory: (baseDir: string) => FileSystem;

  // 构造期注入（phase182 B.p166-5 升档：setter 双阶段消除）
  readonly parentStreamLog?: import('../../foundation/stream/types.js').StreamLog;
  readonly contractNotifyCallback?: (type: string, data: Record<string, unknown>) => void;

  /** phase 521: regime 切换协调装配 / Assembly own factory / per L5.G1-G4 closure 2026-05-07 */
  readonly dialogStoreFactory: () => DialogStore;

  /** phase 1414: inbox 消息 formatter 注册表（Assembly 装配期填、各业主自家 formatter）*/
  readonly formatterRegistry: MessageFormatterRegistry;

  /**
   * phase 1469: motion guidance registry — Assembly motion 装配期填 / claw 装配 undefined.
   * Runtime motion-side formatInboxMessage 末端 append guidance / claw 见 phase 1414 形态不变.
   * 详 design/modules/l2_messaging.md §10.
   */
  readonly guidanceRegistry?: MotionGuidanceRegistry;
}

/** 1:1 保 runtime.ts:74-101 body */
export interface RuntimeOptions {
  clawId: ClawId;
  clawDir: ClawDir;
  /** phase 1387: Assembly 装配期注入的 clawforum 根目录 */
  clawforumRoot: ClawforumRoot;
  llmConfig: LLMOrchestratorConfig;
  maxSteps?: number;
  toolProfile?: ToolProfile;
  maxConsecutiveParseErrors?: number;
  maxConsecutiveMaxTokensToolUse?: number;
  idleTimeoutMs: number;   // LLM stream idle timeout（0 = 禁用、由 config boundary resolve）

  dependencies: RuntimeDependencies;  // 必传（phase155B 起，字段随 phase155C 扩展）

  // Motion/claw 身份差异由 Assembly 按 identity 分支注入（phase266 消除 MotionRuntime subclass）
  systemPromptBuilder?: (params: {
    contextInjector: ContextInjector;
    systemFs: FileSystem;
    audit?: AuditLog;
  }) => Promise<string>;
  identityToolFilter?: (registry: ToolRegistry) => void;

  /** phase 521: regime 切换 messages 继承 strategy / default 'all' / per L5.G1+G2 */
  regimeSwitchStrategy?: 'all' | 'none' | 'last-turn';
}

/** 1:1 保 runtime.ts:102-120 body */
export interface StreamCallbacks {
  onBeforeLLMCall?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: ToolUseId) => void;
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: { success: boolean; content: string }, step: number, maxSteps: number) => void;
  onTurnStart?: (sources: Array<{ text: string; type: string }>) => void;
  onTurnEnd?: () => void;
  onTurnError?: (error: string) => void;
  onTurnInterrupted?: (cause: string, message?: string) => void;
  onProviderInfo?: (info: { name: string; model: string; isFallback: boolean }) => void;
  /** Provider timed out mid-stream, failover starting */
  onProviderFailover?: (info: { from: string; timeoutMs: number }) => void;
  /** Provider failed, failover continuing to next provider */
  onProviderFailed?: (info: { provider: string; model: string; error: string }) => void;
}

/** 1:1 保 runtime.ts:121-126 body */
export interface DaemonStreamCallbacks extends StreamCallbacks {
  onInboxMessages?: (messages: InboxMessage[]) => Promise<void>;
}
