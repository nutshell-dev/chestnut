/**
 * ToolRegistry - Manages tool registration and lookup
 * 
 * Implements ToolRegistry interface
 */

import type { Tool, ToolRegistry } from './executor.js';
import type { ToolProfile } from '../../types/config.js';
import { TOOL_PROFILES } from './profiles.js';

/**
 * Tool registry implementation
 */
export class ToolRegistryImpl implements ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a tool
   * Overwrites existing tool with same name
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool by name
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Get a tool by name
   * @returns Tool or undefined if not found
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools available for a specific profile
   */
  getForProfile(profile: ToolProfile): Tool[] {
    const allowedNames = TOOL_PROFILES[profile];
    return this.getAll().filter(tool => (allowedNames as readonly string[]).includes(tool.name));
  }

  /**
   * Format tools for LLM API consumption
   * @returns Tool definitions in LLM API format
   */
  formatForLLM(tools: Tool[]): Array<{
    name: string;
    description: string;
    input_schema: import('../../types/message.js').JSONSchema7;
  }> {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema,
    }));
  }
}
