/**
 * @module L2.FileTool
 * FileTool module (L2)
 *
 * agent 文件工具：read / write / search / ls
 * 把 OS 文件 I/O 能力翻译为 agent 友好的 Tool 协议对象。
 */

import type { Tool } from '../tool-protocol/index.js';
import type { PermissionChecker } from '../../types/permission.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { searchTool } from './search.js';
import { lsTool } from './ls.js';
import { editTool } from './edit.js';
import { multiEditTool } from './multi_edit.js';
import { setPermissionCheckerFactory } from './permission-context.js';

/** FileTool own sync scratch subdir（turn-scoped / Snapshot whitelist 清理）*/
export const TASKS_SYNC_WRITE_DIR = 'tasks/sync/write';

// Re-export tool objects（让 caller 可单独 import 任一）
export { readTool, writeTool, searchTool, lsTool, editTool, multiEditTool };

/**
 * FileTool 装配选项
 */
export interface FileToolOptions {
  /** Path permission policy factory (Assembly 装配期注入 / 通常 createClawPermissionChecker) */
  permissionCheckerFactory: (clawDir: string) => PermissionChecker;
}

/**
 * FileTool 装配工厂：返回 6 tool 数组（read / write / search / ls / edit / multi_edit per array 顺序）
 *
 * 同 phase378 createCommandTools 模式 / Assembly 装配期调:
 *   for (const tool of createFileTools({ permissionCheckerFactory: ... })) registry.register(tool);
 */
export function createFileTools(options: FileToolOptions): Tool[] {
  setPermissionCheckerFactory(options.permissionCheckerFactory);
  return [readTool, writeTool, searchTool, lsTool, editTool, multiEditTool];
}
