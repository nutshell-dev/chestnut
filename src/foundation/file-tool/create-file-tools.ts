import type { Tool } from '../tools/index.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { searchTool } from './search.js';
import { lsTool } from './ls.js';
import { editTool } from './edit.js';
import { multiEditTool } from './multi_edit.js';

/**
 * FileTool 装配工厂：返回 6 tool 数组（read / write / search / ls / edit / multi_edit per array 顺序）
 *
 * 同 phase378 createCommandTools 模式 / Assembly 装配期调:
 *   for (const tool of createFileTools()) registry.register(tool);
 */
export function createFileTools(): Tool[] {
  return [readTool, writeTool, searchTool, lsTool, editTool, multiEditTool];
}
