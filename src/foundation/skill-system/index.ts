/**
 * @module L2.SkillSystem
 * Skill module exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { SkillSystem } from './registry.js';

export { SkillSystem, type SkillMeta } from './registry.js';
export { SKILLS_DIR_DEFAULT } from './skill-paths.js';

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
