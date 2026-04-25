/**
 * skill tool - Load and use skills from SKILL.md files
 * 
 * Skills provide domain-specific knowledge and guidelines to Claws.
 * Loaded on-demand when this tool is called.
 */

import type { Tool, ToolResult, ExecContext } from '../executor.js';
import { createSkillRegistry, type SkillRegistry } from '../../skill/index.js';

/**
 * Skill tool implementation
 * 
 * Requires skillRegistry to be injected before use.
 */
export const skillTool: Tool & { skillRegistry?: SkillRegistry } = {
  name: 'skill',
  description: 'Load a skill by name. Skills provide domain-specific knowledge and guidelines from SKILL.md files.',
  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The name of the skill to load (e.g., "git-workflow", "code-review")',
      },
      skillsDir: {
        type: 'string',
        description: 'Skills directory to load from. Default: Motion\'s own skill dir. Pass "clawspace/dispatch-skills" for dispatch templates.',
      },
    },
    required: ['name'],
  },
  readonly: true,
  idempotent: true,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const name = String(args.name);

    // Load from custom skills directory if specified (e.g., dispatch templates)
    if (args.skillsDir) {
      try {
        const tempRegistry = createSkillRegistry(ctx.fs, String(args.skillsDir));
        await tempRegistry.loadAll();
        const content = await tempRegistry.loadFull(name);
        return { success: true, content, metadata: { skillName: name } };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          content: `Failed to load skill "${name}" from "${args.skillsDir}": ${errorMsg}`,
          error: errorMsg,
        };
      }
    }

    const skillRegistry = skillTool.skillRegistry;
    
    if (!skillRegistry) {
      return {
        success: false,
        content: 'SkillRegistry not available. Skill tool requires SkillRegistry to be injected.',
        error: 'SkillRegistry not configured',
      };
    }

    try {
      const content = await skillRegistry.loadFull(name);
      return {
        success: true,
        content,
        metadata: { skillName: name },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: `Failed to load skill "${name}": ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
