import { describe, it, expect, vi } from 'vitest';
import { SkillSystem, SkillDuplicateError } from '../../../src/foundation/skill-system/registry.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function mockFs(files: Record<string, string>, dirs: string[]): FileSystem {
  return {
    exists: vi.fn(async (p: string) => p in files || dirs.includes(p)),
    read: vi.fn(async (p: string) => {
      if (!(p in files)) throw new Error(`mock: ${p} not found`);
      return files[p];
    }),
    list: vi.fn(async (p: string, _opts?: object) => {
      const children = dirs
        .filter(d => d.startsWith(p + '/'))
        .map(d => d.slice(p.length + 1))
        .filter(n => !n.includes('/'));
      return children.map(name => ({
        name,
        path: `${p}/${name}`,
        isDirectory: true,
        isFile: false,
        size: 0,
        mtime: new Date(),
      })) as FileEntry[];
    }),
    writeAtomic: vi.fn(),
    append: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    ensureDir: vi.fn(),
    removeDir: vi.fn(),
    isDirectory: vi.fn(async (p: string) => dirs.includes(p)),
    stat: vi.fn(),
    writeAtomicSync: vi.fn(),
    writeExclusiveSync: vi.fn(),
    readSync: vi.fn(),
    readBytesSync: vi.fn(),
    appendSync: vi.fn(),
    statSync: vi.fn(),
    moveSync: vi.fn(),
    existsSync: vi.fn(),
    ensureDirSync: vi.fn(),
    listSync: vi.fn(),
    deleteSync: vi.fn(),
    resolve: vi.fn((p: string) => p),
  } as unknown as FileSystem;
}

function mockAudit(): AuditLog & { calls: Array<[string, ...string[]]> } {
  const calls: Array<[string, ...string[]]> = [];
  return {
    write: vi.fn((type: string, ...args: string[]) => {
      calls.push([type, ...args]);
    }),
    calls,
  } as unknown as AuditLog & { calls: Array<[string, ...string[]]> };
}

describe('phase 1235 B.1: skill registry duplicate reject + namespace enforce', () => {
  it('reverse 1: invalid namespace pattern → throw + audit NAMESPACE_INVALID', async () => {
    const skillsDir = '/skills';
    const skillDir = '/skills/bad';
    const fs = mockFs(
      {
        [`${skillDir}/SKILL.md`]: '---\nname: Bad_Name_With_Underscore\n---\n',
      },
      [skillsDir, skillDir],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    await expect(sys.register(skillDir)).rejects.toThrow('Skill name namespace invalid');

    const invalidAudit = audit.calls.find(c => c[0] === 'skill_namespace_invalid');
    expect(invalidAudit).toBeDefined();
    expect(invalidAudit!.slice(1)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^name=/)]),
    );
  });

  it('reverse 2: duplicate registration (same name, different dir) → throw SkillDuplicateError + audit DUPLICATE_REJECTED', async () => {
    const skillsDir = '/skills';
    const dir1 = '/skills/foo';
    const dir2 = '/skills/foo-dup';
    const fs = mockFs(
      {
        [`${dir1}/SKILL.md`]: '---\nname: foo\n---\n',
        [`${dir2}/SKILL.md`]: '---\nname: foo\n---\n',
      },
      [skillsDir, dir1, dir2],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    await sys.register(dir1);
    await expect(sys.register(dir2)).rejects.toThrow(SkillDuplicateError);

    const dupAudit = audit.calls.find(c => c[0] === 'skill_duplicate_rejected');
    expect(dupAudit).toBeDefined();
    expect(dupAudit!.slice(1)).toEqual(
      expect.arrayContaining([
        'name=foo',
        'existing_skill_dir=/skills/foo',
        'attempted_skill_dir=/skills/foo-dup',
      ]),
    );
  });

  it('reverse 3: single skill happy path → success', async () => {
    const skillsDir = '/skills';
    const skillDir = '/skills/my-skill';
    const fs = mockFs(
      {
        [`${skillDir}/SKILL.md`]: '---\nname: my-skill\ndescription: test\nversion: 1.0.0\n---\n',
      },
      [skillsDir, skillDir],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    const meta = await sys.register(skillDir);
    expect(meta.name).toBe('my-skill');
    expect(meta.description).toBe('test');
    expect(meta.version).toBe('1.0.0');
    expect(sys.getMeta('my-skill')).toEqual(meta);
  });
});
