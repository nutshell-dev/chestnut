import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SkillSystem } from '../../../src/foundation/skill-system/registry.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { ToolError } from '../../../src/types/errors.js';
import { SKILLS_DIR_DEFAULT } from '../../../src/foundation/skill-system/skill-paths.js';

function createMockFs(partial: Partial<FileSystem> = {}): FileSystem {
  return {
    exists: vi.fn(),
    list: vi.fn(),
    read: vi.fn(),
    ...partial,
  } as unknown as FileSystem;
}

function createMockAudit(): AuditLog & { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() } as unknown as AuditLog & { write: ReturnType<typeof vi.fn> };
}

function makeSkillMd(frontmatter: Record<string, string>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---', '# Skill body', '');
  return lines.join('\n');
}

describe('SkillSystem', () => {
  let mockFs: FileSystem;
  let mockAudit: AuditLog & { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockFs = createMockFs();
    mockAudit = createMockAudit();
  });

  describe('loadAll', () => {
    it('skillsDir 不存在 → 发 skill_dir_not_found audit 后 return', async () => {
      (mockFs.exists as any).mockResolvedValue(false);
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      await registry.loadAll();
      expect(registry.listMeta()).toHaveLength(0);
      expect(mockAudit.write).toHaveBeenCalledTimes(1);
      expect(mockAudit.write).toHaveBeenCalledWith('skill_dir_not_found', 'dir=skills');
    });

    it('skillsDir 存在但空 → 发 skill_registry_loaded count=0', async () => {
      (mockFs.exists as any).mockResolvedValue(true);
      (mockFs.list as any).mockResolvedValue([]);
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      await registry.loadAll();
      expect(registry.listMeta()).toHaveLength(0);
      expect(mockAudit.write).toHaveBeenCalledTimes(1);
      const call = (mockAudit.write as any).mock.calls[0];
      expect(call[0]).toBe('skill_registry_loaded');
      expect(call[1]).toBe('skills_dir=skills');
      expect(call[2]).toBe('count=0');
    });

    it('2 skill 正常加载 → 发 skill_registry_loaded count=2', async () => {
      (mockFs.exists as any).mockImplementation((p: string) =>
        Promise.resolve(p === 'skills' || p === 'skills/skill-a/SKILL.md' || p === 'skills/skill-b/SKILL.md'),
      );
      (mockFs.list as any).mockResolvedValue([
        { name: 'skill-a', isDirectory: true },
        { name: 'skill-b', isDirectory: true },
      ]);
      (mockFs.read as any).mockImplementation((p: string) => {
        if (p === 'skills/skill-a/SKILL.md') return Promise.resolve(makeSkillMd({ name: 'alpha', description: 'Alpha desc', version: '1.0.0' }));
        if (p === 'skills/skill-b/SKILL.md') return Promise.resolve(makeSkillMd({ name: 'beta', description: 'Beta desc', version: '2.0.0' }));
        return Promise.reject(new Error('not found'));
      });
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      await registry.loadAll();
      expect(registry.listMeta()).toHaveLength(2);
      const types = (mockAudit.write as any).mock.calls.map((c: any[]) => c[0]);
      expect(types).toContain('skill_registry_loaded');
      const loadedCall = (mockAudit.write as any).mock.calls.find((c: any[]) => c[0] === 'skill_registry_loaded');
      expect(loadedCall[2]).toBe('count=2');
    });

    it('单技能 register 失败 → skill_load_failed + console.warn + continue', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (mockFs.exists as any).mockImplementation((p: string) =>
        Promise.resolve(p === 'skills' || p === 'skills/skill-a/SKILL.md' || p === 'skills/skill-b/SKILL.md'),
      );
      (mockFs.list as any).mockResolvedValue([
        { name: 'skill-a', isDirectory: true },
        { name: 'skill-b', isDirectory: true },
      ]);
      (mockFs.read as any).mockImplementation((p: string) => {
        if (p === 'skills/skill-a/SKILL.md') return Promise.resolve(makeSkillMd({ name: 'alpha', description: 'A', version: '1.0' }));
        if (p === 'skills/skill-b/SKILL.md') return Promise.reject(new Error('disk read error'));
        return Promise.reject(new Error('not found'));
      });
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      await registry.loadAll();
      expect(registry.listMeta()).toHaveLength(1);
      expect(registry.getMeta('alpha')).toBeTruthy();

      const types = (mockAudit.write as any).mock.calls.map((c: any[]) => c[0]);
      expect(types).toContain('skill_load_failed');
      expect(types).toContain('skill_registry_loaded');

      const loadFailedCall = (mockAudit.write as any).mock.calls.find((c: any[]) => c[0] === 'skill_load_failed');
      expect(loadFailedCall[1]).toMatch(/^skill_dir=skills\/skill-b/);
      expect(loadFailedCall[2]).toBe('skills_dir=skills');
      expect(loadFailedCall[3]).toMatch(/^error=/);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('register', () => {
    it('正常 → 返回 SkillMeta + 入 metaMap', async () => {
      (mockFs.read as any).mockResolvedValue(makeSkillMd({ name: 'gamma', description: 'Gamma desc', version: '3.0.0' }));
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      const meta = await registry.register('skills/gamma');
      expect(meta.name).toBe('gamma');
      expect(meta.description).toBe('Gamma desc');
      expect(meta.version).toBe('3.0.0');
      expect(meta.skillDir).toBe('skills/gamma');
      expect(registry.getMeta('gamma')).toEqual(meta);
    });

    it('duplicate 同名 → skill_duplicate_skipped + console.warn + 返回 existing', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (mockFs.read as any).mockResolvedValue(makeSkillMd({ name: 'delta', description: 'D', version: '1.0' }));
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      const first = await registry.register('skills/delta');
      const second = await registry.register('skills/delta-dup');
      expect(second.skillDir).toBe(first.skillDir);

      const dupCall = (mockAudit.write as any).mock.calls.find((c: any[]) => c[0] === 'skill_duplicate_skipped');
      expect(dupCall).toBeTruthy();
      expect(dupCall[1]).toBe('name=delta');
      expect(dupCall[2]).toBe('existing_skill_dir=skills/delta');
      expect(dupCall[3]).toBe('attempted_skill_dir=skills/delta-dup');
      expect(dupCall[4]).toBe('existing_name_source=frontmatter');
      expect(dupCall[5]).toBe('attempted_name_source=frontmatter');
      expect(dupCall[6]).toBe('skills_dir=skills');

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('frontmatter 缺字段 → 用默认值 fallback', async () => {
      (mockFs.read as any).mockResolvedValue('---\n\n---\n');
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      const meta = await registry.register('skills/epsilon');
      expect(meta.name).toBe('epsilon');
      expect(meta.description).toBe('');
      expect(meta.version).toBe('0.0.0');
    });
  });

  describe('query', () => {
    it('getMeta 未注册 → undefined', () => {
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      expect(registry.getMeta('nonexistent')).toBeUndefined();
    });

    it('listMeta 返回全部 SkillMeta', async () => {
      (mockFs.read as any).mockResolvedValue(makeSkillMd({ name: 'zeta', description: 'Z', version: '1.0' }));
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      await registry.register('skills/zeta');
      expect(registry.listMeta()).toHaveLength(1);
      expect(registry.listMeta()[0].name).toBe('zeta');
    });
  });

  describe('loadFull', () => {
    it('已注册 → 返回 SKILL.md 完整内容', async () => {
      const fullContent = makeSkillMd({ name: 'eta', description: 'E', version: '1.0' });
      (mockFs.read as any).mockResolvedValue(fullContent);
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      await registry.register('skills/eta');
      const result = await registry.loadFull('eta');
      expect(result).toBe(fullContent);
    });

    it('未注册 → 抛 ToolError', async () => {
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      await expect(registry.loadFull('nope')).rejects.toThrow(ToolError);
      await expect(registry.loadFull('nope')).rejects.toThrow('Skill "nope" not found');
    });
  });

  describe('formatForContext', () => {
    it('空 → 固定提示文本', () => {
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      expect(registry.formatForContext()).toBe('## Available Skills\nNo skills loaded.\n');
    });

    it('非空 → 列所有 name: description', async () => {
      (mockFs.read as any).mockImplementation((p: string) => {
        if (p.includes('skill-x')) return Promise.resolve(makeSkillMd({ name: 'skill-x', description: 'desc-x', version: '1.0' }));
        if (p.includes('skill-y')) return Promise.resolve(makeSkillMd({ name: 'skill-y', description: 'desc-y', version: '2.0' }));
        return Promise.reject(new Error('not found'));
      });
      const registry = new SkillSystem(mockFs, SKILLS_DIR_DEFAULT, mockAudit);
      await registry.register('skills/skill-x');
      await registry.register('skills/skill-y');
      const formatted = registry.formatForContext();
      expect(formatted).toContain('## Available Skills');
      expect(formatted).toContain('- skill-x: desc-x');
      expect(formatted).toContain('- skill-y: desc-y');
    });
  });
});
