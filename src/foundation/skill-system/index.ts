/**
 * @module L2.SkillSystem
 * Skill module exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { SkillSystem } from './registry.js';
import { SKILLS_DIR_DEFAULT } from './skill-paths.js';

export { SkillSystem, type SkillMeta } from './registry.js';

/**
 * 构造 SkillSystem。
 * 调用方必须在使用前显式 `await registry.loadAll()`（契约 §2.1）。
 */
export function createSkillSystem(
  fs: FileSystem,
  skillsDir: string,
  audit?: AuditLog,
): SkillSystem {
  return new SkillSystem(fs, skillsDir, audit);
}
