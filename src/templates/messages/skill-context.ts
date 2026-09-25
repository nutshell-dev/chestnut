/**
 * M17 提示词片段：技能元信息注入上下文的段头与行字面。
 * 触发/接收者：SkillSystem.formatForContext → system prompt 技能段。
 * 原 owner：foundation/skill-system/registry.ts（加载状态判断、后台加载触发、
 * description 缺省回退分支仍归原 owner；字面呈现归本目录单源）。
 */

/* ------------------------------------------------------------------ */
/* phase 1909 Step C：技能段字面迁入模板单源（机械迁移，逐字节不变）。    */
/* ------------------------------------------------------------------ */

export const AVAILABLE_SKILLS_HEADING = '## Available Skills';
export const NO_SKILLS_LOADED = 'No skills loaded.';
export const SKILL_NO_DESCRIPTION = 'No description';

/** 技能行：name + description（description 缺省回退判断留在调用方）。 */
export function skillLine(name: string, description: string): string {
  return `- ${name}: ${description}`;
}
