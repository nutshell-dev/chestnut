/**
 * Builtin tools - Built-in tool implementations
 */

import type { ToolRegistry } from '../executor.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { lsTool } from './ls.js';
import { searchTool } from './search.js';
import { statusTool } from './status.js';

import { sendTool } from './send.js';

import { skillTool } from './skill.js';

// Re-export all tools
export { readTool, writeTool, lsTool, searchTool, statusTool, sendTool, skillTool };

/**
 * Register all builtin tools to a registry
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(lsTool);
  registry.register(searchTool);
  registry.register(statusTool);

  registry.register(sendTool);

  registry.register(skillTool);
}
