/**
 * @module L2.SkillSystem
 * skill tool - Load and use skills from SKILL.md files
 *
 * Skills provide domain-specific knowledge and guidelines to Claws.
 * Loaded on-demand when this tool is called.
 */

import type { Tool, ExecContext, ExecutionInfra, ExecutionAudit } from '../../tools/index.js';
import type { ToolResult } from '../../tool-protocol/index.js';
import { createSkillSystem, type SkillSystem } from '../index.js';

/**
 * Skill tool implementation
 *
 * Requires skillRegistry to be injected before use.
 */
export const SKILL_TOOL_NAME = 'skill' as const;

export type SkillScope = 'self' | 'dispatch';

export interface SkillToolOptions {
  /**
   * Dispatch skills 物理目录（clawDir-relative）。仅 Motion 装配传入。
   * 不传 = 当前身份无 dispatch 池，scope='dispatch' 运行期 reject。
   */
  dispatchSkillsDir?: string;
}

export function createSkillTool(skillRegistry: SkillSystem, opts: SkillToolOptions = {}): Tool {
  const { dispatchSkillsDir } = opts;
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

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      // phase 1459 α-5: skill 真依赖仅 `ctx.fs + ctx.auditWriter` → `ExecutionInfra & ExecutionAudit` 子接口 sufficient。
      // 编译期标 narrow scope / 测试 fixture 可只 mock `{ fs, auditWriter }` / 不消费 identity/permissions/control dim。
      const deps: ExecutionInfra & ExecutionAudit = ctx;
      const name = String(args.name);
      const scope = (args.scope as SkillScope | undefined) ?? 'self';

      if (scope === 'dispatch') {
        if (!dispatchSkillsDir) {
          return {
            success: false,
            content: `scope="dispatch" unavailable: this identity has no dispatch skill pool (Motion only).`,
            error: 'dispatch_scope_unavailable',
          };
        }
        // 临时二级 registry：本次调用 own 实例、加载指定目录后即用即弃、生命周期不溢出本 execute。
        // phase 382 ratify「二级 registry 机制 = 显式设计、非应急 fallback」。
        try {
          const tempRegistry = createSkillSystem(deps.fs, dispatchSkillsDir, deps.auditWriter);
          await tempRegistry.loadAll();
          const content = await tempRegistry.loadFull(name);
          return { success: true, content, metadata: { name: name } };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
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
