/**
 * @module L2.SkillSystem
 * Skill module exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { SkillRegistry } from './registry.js';
import { SKILLS_DIR_DEFAULT } from './skill-paths.js';

export { SkillRegistry, type SkillMeta } from './registry.js';

/**
 * 构造 SkillRegistry。
 * 调用方必须在使用前显式 `await registry.loadAll()`（契约 §2.1）。
 */
export function createSkillRegistry(
  fs: FileSystem,
  skillsDir: string = SKILLS_DIR_DEFAULT,
  audit?: AuditLog,
): SkillRegistry {
  return new SkillRegistry(fs, skillsDir, audit);
}
