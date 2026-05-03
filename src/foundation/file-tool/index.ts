/**
 * @module L2.FileTool
 * FileTool module (L2)
 *
 * agent 文件工具：read / write / search / ls
 * 把 OS 文件 I/O 能力翻译为 agent 友好的 Tool 协议对象。
 */

import type { Tool } from '../../core/tools/executor.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { searchTool } from './search.js';
import { lsTool } from './ls.js';

// Re-export tool objects（让 caller 可单独 import 任一）
export { readTool, writeTool, searchTool, lsTool };
export { READ_TOOL_NAME } from './read.js';

/**
 * FileTool 装配选项（占位 / r+1 phase 实装 allowedRoots / public/private 域配置）
 */
export interface FileToolOptions {
  // allowedRoots?: string[];  // r+1 phase
}

/**
 * FileTool 装配工厂：返回 4 tool 数组（read / write / search / ls）
 *
 * 同 phase378 createCommandTools 模式 / Assembly 装配期调:
 *   for (const tool of createFileTools({})) registry.register(tool);
 */
export function createFileTools(_options: FileToolOptions = {}): Tool[] {
  return [readTool, writeTool, searchTool, lsTool];
}
