/**
 * Phase 1913 Step C（RACE-PUBLISH-PRECOMMIT-VISIBILITY）——SkillSystem
 * 读侧发布门控。
 *
 * 验收：
 * - 目标目录带发布态 marker（SKILL.md 已落位、其余资源未落位）→ 不注册
 *   半版本，audit PUBLISH_IN_PROGRESS_SKIPPED 留证；
 * - marker 删除（= 提交）后下一轮 loadAll 注册完整版本；
 * - 隐藏发布/恢复工件目录（.skill-staging-* / .skill-trash-*）不参与注册，
 *   即使含完整 SKILL.md 副本；
 * - marker 只按「在与不在」判定：内容损坏不改变 in_progress 语义。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { SkillSystem } from '../../../src/foundation/skill-system/registry.js';
import { SKILL_PUBLISH_MARKER } from '../../../src/foundation/skill-system/skill-paths.js';
import { SKILL_AUDIT_EVENTS } from '../../../src/foundation/skill-system/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

const SKILL_MD = '---\nname: myskill\ndescription: test skill\nversion: 1.0.0\n---\n# myskill\n';

function makeAudit(): { audit: AuditLog; calls: Array<[string, ...string[]]> } {
  const calls: Array<[string, ...string[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...args: (string | number)[]) => {
      calls.push([type, ...(args.map(String) as string[])]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, calls };
}

describe('SkillSystem 发布态门控（Phase 1913 Step C）', () => {
  let baseDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    baseDir = await createTrackedTempDir('skill-publish-visibility-');
    skillsDir = 'skills';
    fs.mkdirSync(`${baseDir}/skills`, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(baseDir);
  });

  function makeSystem(audit: AuditLog): SkillSystem {
    return new SkillSystem(new NodeFileSystem({ baseDir }), skillsDir, audit);
  }

  function writeSkillDir(name: string, opts?: { marker?: boolean | 'garbage' }): void {
    const dir = `${baseDir}/skills/${name}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/SKILL.md`, SKILL_MD.replace('myskill', name));
    if (opts?.marker !== undefined) {
      fs.writeFileSync(
        `${dir}/${SKILL_PUBLISH_MARKER}`,
        opts.marker === 'garbage' ? 'not-json{' : JSON.stringify({ source: '/tmp/x', startedAt: 't' }),
      );
    }
  }

  it('marker 在（SKILL.md 已落位、其余资源未落位）→ 跳过 + audit 留证，不注册半版本', async () => {
    writeSkillDir('committed-skill');
    writeSkillDir('half-skill', { marker: true });
    const { audit, calls } = makeAudit();

    const system = makeSystem(audit);
    await system.loadAll();

    expect(system.listMeta().map(m => m.name)).toEqual(['committed-skill']);
    const skipped = calls.filter(c => c[0] === SKILL_AUDIT_EVENTS.PUBLISH_IN_PROGRESS_SKIPPED);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].join(' ')).toContain('half-skill');
  });

  it('marker 删除（提交）后下一轮 loadAll 注册完整版本', async () => {
    writeSkillDir('half-skill', { marker: true });
    const system = makeSystem(makeAudit().audit);

    await system.loadAll();
    expect(system.listMeta()).toEqual([]);

    // 提交 = 删 marker（单向事实）
    fs.rmSync(`${baseDir}/skills/half-skill/${SKILL_PUBLISH_MARKER}`);
    await system.loadAll();
    expect(system.listMeta().map(m => m.name)).toEqual(['half-skill']);
  });

  it('隐藏发布/恢复工件目录（.skill-staging-* 含完整 SKILL.md）不参与注册', async () => {
    writeSkillDir('committed-skill');
    // staging 目录：完整内容副本（含同名 frontmatter），不跳过会 duplicate
    writeSkillDir('.skill-staging-deadbeef');
    const { audit, calls } = makeAudit();

    const system = makeSystem(audit);
    await system.loadAll();

    expect(system.listMeta().map(m => m.name)).toEqual(['committed-skill']);
    expect(calls.filter(c => c[0] === SKILL_AUDIT_EVENTS.DUPLICATE_REJECTED)).toEqual([]);
  });

  it('marker 内容损坏不改 in_progress 语义（presence-only 判定）', async () => {
    writeSkillDir('half-skill', { marker: 'garbage' });
    const { audit, calls } = makeAudit();

    const system = makeSystem(audit);
    await system.loadAll();

    expect(system.listMeta()).toEqual([]);
    expect(calls.filter(c => c[0] === SKILL_AUDIT_EVENTS.PUBLISH_IN_PROGRESS_SKIPPED)).toHaveLength(1);
  });
});
