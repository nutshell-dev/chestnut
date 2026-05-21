/**
 * Types barrel — re-exports from canonical module-owned locations.
 *
 * During migration: this barrel allows existing consumers to keep working
 * while imports are progressively updated to point directly to canonical sources.
 * Once all consumers are migrated, this directory will be deleted.
 */

// Message types → L1 LLMProvider
export type {
  Role,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  UnknownBlock,
  ContentBlock,
  Message,
  ToolDefinition,
  LLMResponse,
  JSONSchema7,
} from '../foundation/llm-provider/types.js';

// Contract types → L4 ContractSystem
export type {
  ContractStatus,
  SubtaskStatus,
  LastFailedFeedback,
  AcceptanceFailedNotification,
  SubTask,
  Contract,
} from '../core/contract/types.js';

// Messaging types → L2c Messaging
export type {
  InboxMessage,
  OutboxMessage,
  HeartbeatEntry,
  Priority,
} from '../foundation/messaging/types.js';
export { PRIORITY_VALUES } from '../foundation/messaging/types.js';

// Config types → L2b ToolProtocol
export type { ToolProfile } from '../foundation/tool-protocol/index.js';

// Error base + L1/L2 error classes → foundation/errors.ts
export type {
  ErrorCode,
  ErrorDetails,
} from '../foundation/errors.js';
export {
  ClawError,
  PermissionError,
  PathNotInClawSpaceError,
  WriteOperationForbiddenError,
  ToolError,
  ToolNotFoundError,
  ToolInvalidInputError,
  ToolTimeoutError,
  isProgrammingBug,
} from '../foundation/errors.js';

// LLM error classes → L2b LLMOrchestrator
export {
  LLMError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMAuthError,
  LLMNetworkError,
  LLMEmptyResponseError,
  LLMModelNotFoundError,
  LLMAllProvidersFailedError,
  classifyLLMError,
  getUserActionHint,
} from '../foundation/llm-orchestrator/errors.js';
export type { LLMErrorClass, UserActionHint } from '../foundation/llm-orchestrator/errors.js';

// FileSystem errors → L1 FileSystem
export { FileNotFoundError } from '../foundation/fs/types.js';

// L3 runtime errors → L3 AgentExecutor
export {
  MaxStepsExceededError,
  ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError,
  WallTimeExceededError,
} from '../core/agent-executor/errors.js';

// Signal types → L3
export {
  IdleTimeoutSignal,
  PriorityInboxInterrupt,
  UserInterrupt,
} from '../core/signals.js';

// Utility functions → foundation/utils
export { formatErr, safeNumber, oneLine } from '../foundation/utils/format.js';

// Result ADT → foundation/utils
export { ok, err, type Result } from '../foundation/utils/result.js';
