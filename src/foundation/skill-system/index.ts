/**
 * @module L2c.SkillSystem
 * Skill module exports
 */

export { SkillSystem } from './registry.js';
export type { SkillContextSource } from './registry.js';
// phase 1435 F9: + BUNDLED_SKILLS_DIR_NAME barrel re-export
export { SKILLS_DIR_DEFAULT, BUNDLED_SKILLS_DIR_NAME } from './skill-paths.js';

export { createSkillSystem } from './registry.js';
// phase 1872 Step G: 首载失败 owner 类型化错误（caller 按 owner 分类）
export { SkillSystemInitialLoadError } from './registry.js';
export { createSkillTool } from './tools/skill.js';
