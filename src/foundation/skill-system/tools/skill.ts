/**
 * @module L2c.SkillSystem
 * skill tool - Load and use skills from SKILL.md files
 *
 * Skills provide domain-specific knowledge and guidelines to Claws.
 * Loaded on-demand when this tool is called.
 */

import type { Tool, ExecContext } from '../../tools/index.js';
import { formatErr } from "../../node-utils/index.js";
import type { ToolResult } from '../../tool-protocol/index.js';
import type { SkillVersions } from '../version-types.js';
import type { SkillSystem } from '../registry.js';

/**
 * Skill tool implementation
 *
 * Requires skillRegistry to be injected before use.
 */
const SKILL_TOOL_NAME = 'skill' as const;

type SkillScope = 'self' | 'dispatch';

interface SkillToolOptions {
  /**
   * dispatch 技能版本服务（Phase 1919 Step B：固定版本读取唯一入口）。
   * 仅 Motion 装配传入。不传 = 当前身份无 dispatch 池，scope='dispatch' 运行期 reject。
   */
  skillVersions?: SkillVersions;
}

export function createSkillTool(skillRegistry: SkillSystem, opts: SkillToolOptions = {}): Tool {
  const { skillVersions } = opts;
  return {
    name: SKILL_TOOL_NAME,
    profiles: ['full', 'subagent', 'miner'],
    description: 'Load a skill by name. Skills provide domain-specific knowledge and guidelines from SKILL.md files.',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the skill to load (e.g., "git-workflow", "code-review")',
        },
        scope: {
          type: 'string',
          enum: ['self', 'dispatch'],
          default: 'self',
          description: "Which skill pool to load from. 'self' (default) = caller's own skill pool. 'dispatch' = Motion's dispatch template pool (Motion only; rejected for other claws).",
        },
      },
      required: ['name'],
    },
    readonly: true,
    idempotent: true,

    async execute(args: Record<string, unknown>, _ctx: ExecContext): Promise<ToolResult> {
      const name = String(args.name);
      const scope = (args.scope as SkillScope | undefined) ?? 'self';

      if (scope === 'dispatch') {
        if (!skillVersions) {
          return {
            success: false,
            content: `scope="dispatch" unavailable: this identity has no dispatch skill pool (Motion only).`,
            error: 'dispatch_scope_unavailable',
          };
        }
        // Phase 1919 Step B：dispatch 池只读已发布固定版本（owner 物化投影），
        // 不再临时扫 live 目录；版本服务自身持有 audit。
        try {
          const content = await skillVersions.loadPublished(name);
          return { success: true, content, metadata: { name: name } };
        } catch (error) {
          const errorMsg = formatErr(error);
          return {
            success: false,
            content: `Failed to load skill "${name}" from dispatch pool: ${errorMsg}`,
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
        const errorMsg = formatErr(error);
        return {
          success: false,
          content: `Failed to load skill "${name}": ${errorMsg}`,
          error: errorMsg,
        };
      }
    },
  };
}
