/**
 * @module L2.Tools
 * Tool execution constants.
 *
 * `DEFAULT_TOOL_TIMEOUT_MS` — executor 内部兜底安全网，防无限卡死，不替上层做策略判断。
 * 用户配置默认值见 assembly/config-defaults.ts（独立定义，可与此不同）。
 * caller: ToolExecutor ctor fallback only.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 3_600_000;
