/**
 * Chestnut - AI Agent Orchestration System
 * 
 * Main library exports
 */

// Types (canonical sources)
export type {
  TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock,
  ContentBlock, Message, ToolDefinition, LLMResponse, JSONSchema7,
} from './foundation/llm-provider/index.js';
export type {
  DerivableStatus, SubtaskStatus, LastFailedFeedback,
  Contract,
} from './core/contract/index.js';
export type { InboxMessage, OutboxMessage, Priority } from './foundation/messaging/index.js';
export type { ToolProfile } from './foundation/tool-protocol/index.js';

export { ToolError, ToolTimeoutError } from './foundation/tools/index.js';
export {
  LLMTimeoutError,
  LLMAllProvidersFailedError,
  classifyLLMError, getUserActionHint,
} from './foundation/llm-orchestrator/index.js';
export { LLMError, LLMAuthError, LLMEmptyResponseError, LLMModelNotFoundError, LLMNetworkError, LLMRateLimitError } from './foundation/llm-provider/index.js';
export type { LLMErrorClass, UserActionHint } from './foundation/llm-orchestrator/index.js';
export { FileNotFoundError } from './foundation/fs/index.js';
export {
  MaxStepsExceededError, ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError, WallTimeExceededError,
} from './core/agent-executor/index.js';
export { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from './core/step-executor/index.js';
export { formatErr } from './foundation/node-utils/index.js';
export type { PermissionChecker } from './foundation/tool-protocol/index.js';

// Core runtime and modules
export { Runtime, type RuntimeOptions } from './core/runtime/index.js';

// Foundation modules (selective exports)
export type { FileSystem, FileEntry } from './foundation/fs/index.js';
export { NodeFileSystem } from './foundation/fs/index.js';

export { Heartbeat, createHeartbeat } from './core/heartbeat/index.js';

export type { LLMOrchestrator } from './foundation/llm-orchestrator/index.js';
export type { LLMOrchestratorConfig, ProviderConfig, LLMCallOptions } from './foundation/llm-orchestrator/index.js';

// Re-export commonly used types
export type { ToolResult } from './foundation/tool-protocol/index.js';
export type { ExecContext, Tool } from './foundation/tools/index.js';
export type { ToolRegistry, IToolExecutor } from './foundation/tools/index.js';
export type { SubAgentTask } from './core/async-task-system/index.js';
export type { ProgressData, VerificationResult } from './core/contract/index.js';
