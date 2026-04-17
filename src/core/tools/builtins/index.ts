/**
 * Builtin tools - Built-in tool implementations
 */

import type { ToolRegistry } from '../executor.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { lsTool } from './ls.js';
import { searchTool } from './search.js';
import { statusTool } from './status.js';
import { execTool } from './exec.js';
import { sendTool } from './send.js';
import { spawnTool } from './spawn.js';
import { skillTool } from './skill.js';
import { doneTool } from './done.js';
import { memorySearchTool } from './memory_search.js';

// Re-export all tools
export { readTool, writeTool, lsTool, searchTool, statusTool, execTool, sendTool, spawnTool, skillTool, doneTool, memorySearchTool };

/**
 * Register all builtin tools to a registry
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(lsTool);
  registry.register(searchTool);
  registry.register(statusTool);
  registry.register(execTool);
  registry.register(sendTool);
  registry.register(spawnTool);
  registry.register(skillTool);
  registry.register(doneTool);
  registry.register(memorySearchTool);
}
