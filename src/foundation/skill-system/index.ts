/**
 * @module L2c.SkillSystem
 * Skill module exports
 */

export { SkillSystem } from './registry.js';
// phase 1435 F9: + BUNDLED_SKILLS_DIR_NAME barrel re-export
export { SKILLS_DIR_DEFAULT, BUNDLED_SKILLS_DIR_NAME } from './skill-paths.js';

export { createSkillSystem } from './registry.js';
