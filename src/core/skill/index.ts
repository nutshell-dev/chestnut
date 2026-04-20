/**
 * Skill module exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import { SkillRegistry } from './registry.js';

export { SkillRegistry, type SkillMeta } from './registry.js';

/**
 * 构造 SkillRegistry。
 * 调用方必须在使用前显式 `await registry.loadAll()`（契约 §2.1）。
 */
export function createSkillRegistry(
  fs: FileSystem,
  skillsDir: string = 'skills',
): SkillRegistry {
  return new SkillRegistry(fs, skillsDir);
}
