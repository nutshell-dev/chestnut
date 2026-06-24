/**
 * Chestnut - AI Agent Orchestration System
 * 
 * Main library exports
 */

// Types (canonical sources)
export type {
  Role, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, UnknownBlock,
  ContentBlock, Message, ToolDefinition, LLMResponse, JSONSchema7,
} from './foundation/llm-provider/index.js';
export type {
  ContractStatus, SubtaskStatus, LastFailedFeedback,
  AcceptanceFailedNotification, SubTask, Contract,
} from './core/contract/types.js';
export type { InboxMessage, OutboxMessage, HeartbeatEntry, Priority } from './foundation/messaging/index.js';
export { PRIORITY_VALUES } from './foundation/messaging/index.js';
export type { ToolProfile } from './foundation/tool-protocol/index.js';
export type { CallerType } from './core/caller-types.js';
export {
  PermissionError, PathNotInClawSpaceError, WriteOperationForbiddenError,
} from './core/permissions/errors.js';
export { ToolError, ToolTimeoutError } from './foundation/tools/errors.js';
export {
  LLMError, LLMRateLimitError, LLMTimeoutError, LLMAuthError, LLMNetworkError,
  LLMEmptyResponseError, LLMModelNotFoundError, LLMAllProvidersFailedError,
  classifyLLMError, getUserActionHint,
} from './foundation/llm-orchestrator/errors.js';
export type { LLMErrorClass, UserActionHint } from './foundation/llm-orchestrator/errors.js';
export { FileNotFoundError } from './foundation/fs/index.js';
export {
  MaxStepsExceededError, ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError, WallTimeExceededError,
} from './core/agent-executor/errors.js';
export { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from './core/signals.js';
export { formatErr } from './foundation/node-utils/format.js';
export type { PermissionChecker } from './foundation/tool-protocol/permission.js';

// Core runtime and modules
export { Runtime, type RuntimeOptions } from './core/runtime/index.js';

// Foundation modules (selective exports)
export type { FileSystem, FileEntry, FileSystemOptions } from './foundation/fs/index.js';
export { NodeFileSystem } from './foundation/fs/index.js';

export { Heartbeat, createHeartbeat } from './core/runtime/index.js';

export type { LLMOrchestrator } from './foundation/llm-orchestrator/index.js';
export { LLMOrchestratorImpl } from './foundation/llm-orchestrator/index.js';
export type { LLMOrchestratorConfig, ProviderConfig, LLMCallOptions } from './foundation/llm-orchestrator/index.js';

// Re-export commonly used types
export type { ToolResult } from './foundation/tool-protocol/index.js';
export type { ExecContext, Tool } from './foundation/tools/index.js';
export type { ToolRegistry, IToolExecutor } from './foundation/tools/executor.js';
export { ToolRegistryImpl } from './foundation/tools/registry.js';
export type { SkillMeta } from './foundation/skill-system/index.js';
export type { SubAgentTask } from './core/async-task-system/index.js';
export type { ProgressData, VerificationResult } from './core/contract/index.js';


