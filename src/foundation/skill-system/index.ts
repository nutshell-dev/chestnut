/**
 * @module L2.SkillSystem
 * Skill module exports
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { SkillSystem } from './registry.js';

export { SkillSystem, type SkillMeta } from './registry.js';
// phase 1435 F9: + BUNDLED_SKILLS_DIR_NAME barrel re-export
export { SKILLS_DIR_DEFAULT, BUNDLED_SKILLS_DIR_NAME } from './skill-paths.js';

/**
 * 构造 SkillSystem。
 * loadAll 为 lazy init — 首次调用 `loadFull()` / `getMeta()` 时自动触发。
 */
export function createSkillSystem(
  fs: FileSystem,
  skillsDir: string,
  audit?: AuditLog,
): SkillSystem {
  return new SkillSystem(fs, skillsDir, audit);
}
