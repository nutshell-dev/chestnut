/**
 * Tool name constants - central registry for all tool names
 *
 * Phase 347: Extracted from individual tool files to prevent circular
 * dependency between profiles.ts and task tools (spawn/dispatch/ask-motion).
 */

export const READ_TOOL_NAME = 'read' as const;
export const WRITE_TOOL_NAME = 'write' as const;
export const SEARCH_TOOL_NAME = 'search' as const;
export const LS_TOOL_NAME = 'ls' as const;
export const SEND_TOOL_NAME = 'send' as const;
export const DONE_TOOL_NAME = 'done' as const;
export const SKILL_TOOL_NAME = 'skill' as const;
export const EXEC_TOOL_NAME = 'exec' as const;
export const STATUS_TOOL_NAME = 'status' as const;
export const MEMORY_SEARCH_TOOL_NAME = 'memory_search' as const;
export const SPAWN_TOOL_NAME = 'spawn' as const;
export const ASK_MOTION_TOOL_NAME = 'ask_motion' as const;
export const DISPATCH_TOOL_NAME = 'dispatch' as const;
