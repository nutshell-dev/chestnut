/**
 * @module L3.SubAgent
 * SubAgent exports
 */

export { NoopAuditWriter } from './noop-writers.js';
export { runSubagent, getDisplayResult, getSubagentStillRunning } from './run.js';
export type { SubagentStillRunningEvidence } from './run.js';
export type { DegradedArtifact } from './agent.js';
// phase 1858 Step B (SA-D1): 命名输入与 typed outcome 显式导出、编译器检查唯一入口
export type { RunSubagentOptions, RunSubagentResult } from './run.js';
export { createDoneTool, DONE_TOOL_NAME } from './tools/done.js';
export { createPerTaskRegistry } from './registry-helper.js';
export { TASKS_SYNC_SUBAGENT_DIR, TASKS_SUBAGENTS_DIR, SUBAGENT_SNAPSHOT_IGNORE } from './constants.js';
// phase 1879 Step C: subagent run 结果目录存在性查询（布局归 owner；0-instance-dep 只读）
export { resolveSubagentRunDir } from './result-dir-query.js';

export { SUBAGENT_FILE_ROUTING } from './audit-events.js';

// phase 1789: agent turn 生命周期 wire 事件语义 owner（自 agent-executor 迁回）
export { SUBAGENT_EVENTS } from './stream-events.js';
export type { SubagentEvent } from './stream-events.js';
