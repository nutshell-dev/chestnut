/**
 * @module L2.FileTool
 * FileTool module (L2)
 *
 * agent 文件工具：read / write / search / ls
 * 把 OS 文件 I/O 能力翻译为 agent 友好的 Tool 协议对象。
 */

import type { Tool } from '../tools/index.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { searchTool } from './search.js';
import { lsTool } from './ls.js';
import { editTool } from './edit.js';
import { multiEditTool } from './multi_edit.js';

// Re-export tool objects（让 caller 可单独 import 任一）
export { readTool, writeTool, searchTool, lsTool, editTool, multiEditTool };
export { TASKS_SYNC_WRITE_DIR } from './constants.js';

/**
 * FileTool 装配选项 (phase 1006: permissionChecker 改由 ExecContext 注入，此 options 保留为未来扩展)
 */
export interface FileToolOptions {
  // 保留空接口避免 caller 破坏；未来可在此加新 dep
}

/**
 * FileTool 装配工厂：返回 6 tool 数组（read / write / search / ls / edit / multi_edit per array 顺序）
 *
 * 同 phase378 createCommandTools 模式 / Assembly 装配期调:
 *   for (const tool of createFileTools()) registry.register(tool);
 */
export function createFileTools(_options?: FileToolOptions): Tool[] {
  return [readTool, writeTool, searchTool, lsTool, editTool, multiEditTool];
}
