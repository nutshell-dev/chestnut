/**
 * @module L2c.Tools
 * Tool execution constants.
 *
 * `DEFAULT_TOOL_TIMEOUT_MS` — executor 内部兜底安全网，防无限卡死，不替上层做策略判断。
 * 用户配置默认值见 assembly/config-defaults.ts（独立定义，可与此不同）。
 * caller: ToolExecutor ctor fallback only.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 3_600_000;

/**
 * Observation budget (ms) after a tool timeout: the executor requests abort and
 * records `cleanup=pending` if the real handler is still running at this point.
 * This timer never completes the execution or delivers its completion.
 *
 * Value: 3000 = L1 exec worst-case honest cleanup (TERM grace 1000 +
 * post-KILL confirm 1000, see foundation/process-exec/constants.ts) + 1000
 * scheduling margin. Must stay >= PROCESS_EXEC_SIGKILL_GRACE_MS +
 * PROCESS_EXEC_GROUP_KILL_CONFIRM_MS, otherwise healthy exec tools would
 * systematically report cleanup=pending.
 */
export const TOOL_EXEC_CLEANUP_BUDGET_MS = 3000;

/** Default final-response guard for tools without a stricter owner policy. */
export const DEFAULT_TOOL_OUTPUT_BOUNDS = Object.freeze({
  maxBytes: 64 * 1024,
  maxLines: 1_000,
  artifactKind: 'tool',
});

/** Executor-owned artifacts live below this caller/claw-relative directory. */
export const TOOL_OUTPUT_ARTIFACT_ROOT = 'tasks/sync';

/** Tools-owned execution facts; every execution has an isolated child directory. */
export const TOOL_EXECUTION_JOURNAL_ROOT = 'tasks/sync/tool-executions';


