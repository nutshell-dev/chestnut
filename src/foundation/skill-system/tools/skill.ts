/**
 * @module L2.SkillSystem
 * skill tool - Load and use skills from SKILL.md files
 *
 * Skills provide domain-specific knowledge and guidelines to Claws.
 * Loaded on-demand when this tool is called.
 */

import type { Tool, ExecContext } from '../../tools/index.js';
import type { ToolResult } from '../../tool-protocol/index.js';
import { createSkillSystem, type SkillSystem } from '../index.js';

/**
 * Skill tool implementation
 *
 * Requires skillRegistry to be injected before use.
 */
export const SKILL_TOOL_NAME = 'skill' as const;

export function createSkillTool(skillRegistry: SkillSystem): Tool {
  return {
    name: SKILL_TOOL_NAME,
    profiles: ['full', 'subagent', 'miner'],
    group: 'skill',
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
          const tempRegistry = createSkillSystem(ctx.fs, String(args.skillsDir), ctx.auditWriter);
          await tempRegistry.loadAll();
          const content = await tempRegistry.loadFull(name);
          return { success: true, content, metadata: { name: name } };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            content: `Failed to load skill "${name}" from "${args.skillsDir}": ${errorMsg}`,
            error: errorMsg,
          };
        }
      }

      try {
        const content = await skillRegistry.loadFull(name);
        return {
          success: true,
          content,
          metadata: { name: name },
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
}
