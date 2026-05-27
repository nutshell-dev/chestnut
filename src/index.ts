/**
 * Clawforum - AI Agent Orchestration System
 * 
 * Main library exports
 */

// Types (canonical sources)
export type {
  Role, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, UnknownBlock,
  ContentBlock, Message, ToolDefinition, LLMResponse, JSONSchema7,
} from './foundation/llm-provider/types.js';
export type {
  ContractStatus, SubtaskStatus, LastFailedFeedback,
  AcceptanceFailedNotification, SubTask, Contract,
} from './core/contract/types.js';
export type { InboxMessage, OutboxMessage, HeartbeatEntry, Priority } from './foundation/messaging/types.js';
export { PRIORITY_VALUES } from './foundation/messaging/types.js';
export type { ToolProfile } from './foundation/tool-protocol/index.js';
export type { CallerType } from './core/caller-types.js';
export type { ErrorCode, ErrorDetails } from './foundation/errors.js';
export {
  ClawError, PermissionError, PathNotInClawSpaceError, WriteOperationForbiddenError,
  ToolError, ToolNotFoundError, ToolInvalidInputError, ToolTimeoutError, isProgrammingBug,
} from './foundation/errors.js';
export {
  LLMError, LLMRateLimitError, LLMTimeoutError, LLMAuthError, LLMNetworkError,
  LLMEmptyResponseError, LLMModelNotFoundError, LLMAllProvidersFailedError,
  classifyLLMError, getUserActionHint,
} from './foundation/llm-orchestrator/errors.js';
export type { LLMErrorClass, UserActionHint } from './foundation/llm-orchestrator/errors.js';
export { FileNotFoundError } from './foundation/fs/types.js';
export {
  MaxStepsExceededError, ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError, WallTimeExceededError,
} from './core/agent-executor/errors.js';
export { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from './core/signals.js';
export { formatErr, safeNumber, oneLine, SUMMARY_MAX_CHARS } from './foundation/utils/format.js';
export { ok, err, type Result } from './foundation/utils/result.js';
export type { PermissionChecker } from './foundation/tool-protocol/permission.js';

// Core runtime and modules
export { Runtime, type RuntimeOptions } from './core/runtime/index.js';

// Foundation modules (selective exports)
export type { FileSystem, FileEntry, FileSystemOptions } from './foundation/fs/types.js';
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


