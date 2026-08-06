// phase 473: resolve-path barrel re-export
export { resolveWorkspacePath } from './resolve-path.js';
// phase 479: file-state-persist barrel re-export
// Phase 1229 Step A: Runtime calls persistReadFileState at complete step boundary.
export { loadReadFileState, clearReadFileState, persistReadFileState } from './file-state-persist.js';
// phase 1209: truncate-head-tail barrel re-export
export { truncateHeadTail } from './truncate-head-tail.js';

/**
 * @module L2c.FileTool
 * FileTool module (L2)
 *
 * agent 文件工具：read / write / search / ls
 * 把 OS 文件 I/O 能力翻译为 agent 友好的 Tool 协议对象。
 */

// Re-export tool objects（让 caller 可单独 import 任一）
export { readTool } from './read.js';
export { searchTool } from './search.js';
export { lsTool } from './ls.js';
export { TASKS_SYNC_WRITE_DIR, TASKS_SYNC_SEARCH_DIR } from './constants.js';
export { createFileTools, type FileToolOptions } from './create-file-tools.js';
