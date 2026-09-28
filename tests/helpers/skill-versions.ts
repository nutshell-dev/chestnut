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
    // Phase 1919 Step C: 分支编辑事务（默认无事务：begin 拒绝、查询 not_found）
    beginEdit: vi.fn(async () => {
      throw new Error('mock skill versions: beginEdit not configured');
    }),
    submitEdit: vi.fn(async (editId: string) => {
      throw new Error(`mock skill versions: no such edit: ${editId}`);
    }),
    retryEdit: vi.fn(async () => {
      throw new Error('mock skill versions: retryEdit not configured');
    }),
    cancelEdit: vi.fn(async (editId: string) => {
      throw new Error(`mock skill versions: no such edit: ${editId}`);
    }),
    editStatus: vi.fn(async (editId: string) => {
      throw new Error(`mock skill versions: no such edit: ${editId}`);
    }),
    editHistory: vi.fn(async () => [] as const),
    // Phase 1919 Step F: 安装来源版本固定（默认无已发布版本：导出 not_found）
    exportSkillVersion: vi.fn(async (input: { name: string }) => {
      throw new Error(`mock skill versions: no published version of "${input.name}" to export`);
    }),
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
