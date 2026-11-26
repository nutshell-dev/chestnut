/**
 * @module L3.SubAgent
 * SubAgent exports
 */

export { NoopAuditWriter } from './noop-writers.js';
export { runSubagent, startSubagent, projectSubagentResult, getDisplayResult } from './run.js';
export type { DegradedArtifact } from './agent.js';
// phase 1858 Step B (SA-D1): 命名输入与 typed outcome 显式导出、编译器检查唯一入口
export type { RunSubagentOptions, RunSubagentResult } from './run.js';
export { createDoneTool, DONE_TOOL_NAME } from './tools/done.js';
export { createPerTaskRegistry } from './registry-helper.js';
export { SUBAGENT_TIMEOUT_MS, TASKS_SYNC_SUBAGENT_DIR, TASKS_SUBAGENTS_DIR, SUBAGENT_SNAPSHOT_IGNORE, SUBAGENT_EXECUTION_DIR } from './constants.js';
// phase 1879 Step C: subagent run 结果目录存在性查询（布局归 owner；0-instance-dep 只读）
export { resolveSubagentRunDir } from './result-dir-query.js';

export { SUBAGENT_FILE_ROUTING } from './audit-events.js';

// Phase 2248 E: versioned, JSON-only execution declarations.
export {
  decodeSubagentInput,
  PREPARED_SUBAGENT_INPUT_KIND,
  prepareSubagentInput,
} from './execution-input.js';
export type {
  PreparedSubagentInput,
  PreparedSubagentInputBudget,
  SubagentInputBudgetDeclaration,
  SubagentInputDeclaration,
  SubagentResultCaptureDeclaration,
  SubagentSystemPromptDeclaration,
  SubagentTemplateSystemPrompt,
  SubagentTextSystemPrompt,
} from './execution-input.js';

// Phase 2248 C/D: persistent admission, observation and self-owned execution.
export { createSubagentRunner, SubagentExecutionReference, SubagentRunnerImpl } from './execution-reference.js';
export { createSubagentExecutionRunner, SubagentExecutionRunner } from './execution-runner.js';
export type {
  SubagentAttempt,
  SubagentAttemptResult,
  SubagentExecutionDriver,
  SubagentExecutionRunnerOptions,
} from './execution-runner.js';
export {
  createSubagentExecutionStore,
  normalizeSubagentLocation,
  SubagentAttemptWriter,
  SubagentExecutionStore,
  SubagentExecutionStoreError,
  SubagentOwnerUnavailableError,
} from './execution-store.js';
export type { SubagentAttemptClaim, SubagentClaimResult, SubagentExecutionRead, SubagentTransitionResult } from './execution-store.js';
export type {
  SubagentArtifactReference,
  SubagentExecutionDegraded,
  SubagentExecutionIdentity,
  SubagentExecutionLocation,
  SubagentExecutionObserver,
  SubagentExecutionOptions,
  SubagentExecutionPersistence,
  SubagentExecutionQuery,
  SubagentExecutionRef,
  SubagentExecutionState,
  SubagentExecutionView,
  SubagentExecutionWriteEvidence,
  SubagentFinalOutcome,
  SubagentJsonValue,
  SubagentObservation,
  SubagentOutcomeKind,
  SubagentProcessCapability,
  SubagentRecoveryFact,
  SubagentResumeRequest,
  SubagentRunner,
  SubagentSettlementInput,
  SubagentStartRequest,
  SubagentStopReceipt,
  SubagentTransition,
} from './execution-types.js';

// Phase 1933 Step D: 通用安全续跑（恢复 checkpoint store + 游标类型）
// Phase 1933 Step G: 游标安全边界（commitConversation + 不确定副作用 typed 错误）
export { createSubAgentRecoveryStore, SubAgentRecoveryStore, SubAgentRecoveryStoreError, RecoveryUncertainSideEffectError, SubAgentRecoveryRequiredError } from './recovery-state.js';
export type { ResumeCursor, RecoveryCursorLoadResult, RecoveryCursorStrictLoad, SubAgentRecoveryStoreOptions, SubAgentRecoveryErrorKind } from './recovery-state.js';

// phase 1789: agent turn 生命周期 wire 事件语义 owner（自 agent-executor 迁回）
export { SUBAGENT_EVENTS } from './stream-events.js';
export type { SubagentEvent } from './stream-events.js';
