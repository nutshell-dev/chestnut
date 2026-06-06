/**
 * @module L2.Tools
 * Tool execution constants.
 *
 * `DEFAULT_TOOL_TIMEOUT_MS` — executor 内部兜底安全网，防无限卡死，不替上层做策略判断。
 * 用户配置默认值见 assembly/config-defaults.ts（独立定义，可与此不同）。
 * caller: ToolExecutor ctor fallback only.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 3_600_000;

/**
 * escapeForLog helper 输出截断 cap.
 * 用于 log / audit display 时把 tool args / output 转 \\n 转义 + 截断到此长度、防 log 行过长。
 * caller: foundation/tools/types.ts escapeForLog().
 */
export const TOOL_LOG_ESCAPE_CHARS = 120;
