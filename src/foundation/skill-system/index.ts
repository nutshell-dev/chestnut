/**
 * @module L2c.SkillSystem
 * Skill module exports
 */

export { SkillSystem } from './registry.js';
export type { SkillContextSource } from './registry.js';
// phase 1435 F9: + BUNDLED_SKILLS_DIR_NAME barrel re-export
export { SKILLS_DIR_DEFAULT, BUNDLED_SKILLS_DIR_NAME, SKILL_PUBLISH_MARKER, SKILL_SOURCE_SNAPSHOT_PREFIX, SKILL_COMMIT_PROOF } from './skill-paths.js';

export { createSkillSystem } from './registry.js';
// phase 1872 Step G: 首载失败 owner 类型化错误（caller 按 owner 分类）
export { SkillSystemInitialLoadError } from './registry.js';
export { createSkillTool } from './tools/skill.js';
// Phase 1919 Step B: dispatch 技能版本服务（正式发布/读取唯一入口）
export { createSkillVersions, SkillVersionService } from './version-service.js';
export type { SkillVersionsOptions } from './version-service.js';
export type {
  SkillVersions,
  PublishedSkill,
  SkillBasis,
  SkillPublishResult,
  ImportSkillInput,
  SkillVersionErrorKind,
} from './version-types.js';
export { SkillVersionError } from './version-types.js';
export { DISPATCH_WORKSPACES_DIR_NAME, DISPATCH_VERSION_STATE_DIR_NAME } from './skill-paths.js';
