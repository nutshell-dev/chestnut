import { vi } from 'vitest';
import type { SkillVersions } from '../../src/foundation/skill-system/index.js';
import type { SkillVersionsOptions } from '../../src/foundation/skill-system/index.js';

/**
 * Test helper (Phase 1919 Step B): mock SkillVersions 固定版本服务。
 * 默认行为：无已发布技能（摘要 'No skills loaded'，读取 not_found）。
 */
export function makeMockSkillVersions(overrides?: Partial<SkillVersions>): SkillVersions {
  return {
    readPublished: vi.fn(async (name: string) => {
      throw new Error(`dispatch skill "${name}" has no published version`);
    }),
    loadPublished: vi.fn(async (name: string) => {
      throw new Error(`dispatch skill "${name}" has no published version`);
    }),
    formatPublishedForContext: vi.fn(async () => 'No skills loaded'),
    importSkill: vi.fn(async () => ({ kind: 'published', version: '0'.repeat(40) }) as const),
    ...overrides,
  } as unknown as SkillVersions;
}

/**
 * AssembleOverrides.createSkillVersions 注入用工厂：不触碰真实嵌套 Git，
 * 记录构造参数供断言，返回 makeMockSkillVersions()。
 */
export function makeMockCreateSkillVersions(versions?: SkillVersions) {
  const resolved = versions ?? makeMockSkillVersions();
  return vi.fn(async (_opts: SkillVersionsOptions) => resolved);
}
