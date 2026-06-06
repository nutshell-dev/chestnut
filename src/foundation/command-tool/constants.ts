/** Truncation threshold for combined exec output (β 应用层 / 应然 §10.4 ~2000) */
export const EXEC_MAX_OUTPUT = 2000;

/** CommandTool overflow scratch 子目录名（phase 1475 提取常量、消 split.pop()! non-null assertion） */
export const EXEC_OVERFLOW_DIR_NAME = 'exec';

/** exec ToolResult 空 output placeholder 内 command 字段截断字符上限（phase 96 加、phase 100 const 化、消费方 = LLM ctx + viewport 渲染） */
export const EXEC_COMMAND_PLACEHOLDER_CHARS = 200;

/** CommandTool own sync scratch subdir（turn-scoped / Snapshot whitelist 清理）*/
export const TASKS_SYNC_EXEC_DIR = `tasks/sync/${EXEC_OVERFLOW_DIR_NAME}`;
