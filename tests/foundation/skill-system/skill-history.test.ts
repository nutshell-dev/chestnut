/**
 * Phase 1923 Step B：技能版本提交历史（SkillVersions.skillHistory，真实 Git）。
 *
 * 验收：
 * - 混合来源对账：baseline/import/edit 发布与未发布事务（conflict）按
 *   publishOperationId 去重合并——已发布编辑保留 editId 身份且不重复条目，
 *   import/baseline 无 editId；条目含 version/operationId/commit 时间/依据；
 * - 旧记录（pre-1920 无 metadata 原文）依据显式 null 缺失，不伪造；
 * - 重启（新实例）后历史事实一致；
 * - 损坏的持久依据 loud store_error，不静默降级为缺失。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import {
  createSkillVersions,
  SkillVersionError,
  type SkillBasis,
  type SkillEditHandle,
  type SkillHistoryEntry,
  type SkillVersions,
} from '../../../src/foundation/skill-system/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { sha256Hex } from '../../../src/foundation/node-utils/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const SKILL_MD = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`;
const editBasis: SkillBasis = { actor: 'subagent:retro1', reason: 'retro improvement', sourceRefs: ['subagent-task:t-1', 'retro:c-1'] };
const importBasis: SkillBasis = { actor: 'user-install', reason: 'skill install beta', sourceRefs: ['dispatch://skill/beta'] };

describe.skipIf(!gitAvailable)('SkillVersions 技能版本提交历史（Phase 1923 Step B）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-history-');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  const repositoryDir = () => path.join(tmpDir, 'motion', 'clawspace', 'dispatch-skills');
  const workspaceParent = () => path.join(tmpDir, 'motion', 'clawspace', '.dispatch-workspaces');
  const stateDir = () => path.join(tmpDir, 'motion', 'clawspace', '.dispatch-version-state');

  function fsFactory(baseDir: string): NodeFileSystem {
    return new NodeFileSystem({ baseDir });
  }

  async function makeService(): Promise<SkillVersions> {
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    return createSkillVersions({
      repositoryDir: repositoryDir(),
      workspaceParent: workspaceParent(),
      stateDir: stateDir(),
      fsFactory,
      audit: makeAudit().audit,
    });
  }

  function seedBaseline(): void {
    const alpha = path.join(repositoryDir(), 'alpha');
    fsSync.mkdirSync(alpha, { recursive: true });
    fsSync.writeFileSync(path.join(alpha, 'SKILL.md'), SKILL_MD('alpha', '# Alpha orig\n'));
  }

  function skillSrc(name: string, body: string): string {
    const src = path.join(tmpDir, `src-${name}`);
    fsSync.mkdirSync(src, { recursive: true });
    fsSync.writeFileSync(path.join(src, 'SKILL.md'), SKILL_MD(name, body));
    return src;
  }

  function writeWsFile(handle: SkillEditHandle, rel: string, content: string): void {
    const abs = path.join(handle.path, rel);
    fsSync.mkdirSync(path.dirname(abs), { recursive: true });
    fsSync.writeFileSync(abs, content);
  }

  /** Snapshot publish 操作记录文件（.git/version-store/publishes/<sha256(publish:opId)>.json） */
  function publishRecordPath(operationId: string): string {
    return path.join(repositoryDir(), '.git', 'version-store', 'publishes', `${sha256Hex(`publish:${operationId}`)}.json`);
  }

  it('混合来源对账：baseline/import/edit 发布去重合并，conflict 事务独立呈现', async () => {
    seedBaseline();
    const svc = await makeService();

    // import 发布 beta（无编辑事务）
    const imp = await svc.importSkill({ name: 'beta', source: skillSrc('beta', '# Beta v1\n'), operationId: 'imp-beta-1', basis: importBasis });
    expect(imp.kind).toBe('published');

    // 编辑发布 alpha（winner）+ 冲突编辑（loser）
    const a = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-a', basis: editBasis });
    const b = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-b', basis: editBasis });
    writeWsFile(a, 'SKILL.md', SKILL_MD('alpha', '# Alpha by A\n'));
    writeWsFile(b, 'SKILL.md', SKILL_MD('alpha', '# Alpha by B\n'));
    const sa = await svc.submitEdit(a.editId);
    expect(sa.kind).toBe('published');
    const sb = await svc.submitEdit(b.editId);
    expect(sb.kind).toBe('conflict');

    const history = await svc.skillHistory('alpha');
    // baseline + edit 发布 + conflict 事务 = 3 条（edit 发布按 operationId 去重，不重复）
    expect(history.length).toBe(3);

    const publishedEntry = history.find(e => e.status === 'published' && e.editId === a.editId);
    expect(publishedEntry).toBeDefined();
    expect(publishedEntry?.version).toBe(sa.kind === 'published' ? sa.version : '');
    expect(publishedEntry?.operationId).toBe(`edit-publish-${a.editId}`);
    expect(publishedEntry?.basis).toEqual(editBasis);
    // 同一 version 只出现一次（Snapshot 历史与编辑事务记录不形成两个条目）
    expect(history.filter(e => e.version === publishedEntry?.version).length).toBe(1);

    const baselineEntry = history.find(e => e.status === 'published' && e.editId === null);
    expect(baselineEntry).toBeDefined();
    expect(baselineEntry?.operationId).toMatch(/^baseline-.*-publish-alpha$/);
    expect(baselineEntry?.basis?.actor).toBe('skill-version-migration');

    const conflictEntry = history.find(e => e.status === 'conflict');
    expect(conflictEntry).toBeDefined();
    expect(conflictEntry?.editId).toBe(b.editId);
    expect(conflictEntry?.version).toBeNull();
    expect(conflictEntry?.basis).toEqual(editBasis);
    expect(conflictEntry?.operationId).toBe(`edit-publish-${b.editId}`);

    // 时间均可解析；新→旧稳定排序（单调不增）
    for (const e of history) {
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    }
    const timestamps = history.map(e => Date.parse(e.at));
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }

    // import 发布：editId null、依据为安装 basis
    const betaHistory = await svc.skillHistory('beta');
    expect(betaHistory.length).toBe(1);
    expect(betaHistory[0].status).toBe('published');
    expect(betaHistory[0].editId).toBeNull();
    expect(betaHistory[0].operationId).toBe('imp-beta-1');
    expect(betaHistory[0].basis).toEqual(importBasis);

    // 从未发布/编辑过的技能：空历史
    expect(await svc.skillHistory('never')).toEqual([]);
  });

  it('旧记录（无持久 metadata 原文）依据显式 null 缺失，不伪造；损坏记录 loud', async () => {
    seedBaseline();
    const svc = await makeService();
    const imp = await svc.importSkill({ name: 'beta', source: skillSrc('beta', '# Beta v1\n'), operationId: 'imp-beta-legacy', basis: importBasis });
    expect(imp.kind).toBe('published');

    // 模拟 pre-1920 旧记录：移除 metadata 原文字段（hash 字段保留，记录形状仍合法）
    const recPath = publishRecordPath('imp-beta-legacy');
    const rec = JSON.parse(fsSync.readFileSync(recPath, 'utf-8')) as Record<string, unknown>;
    delete rec.metadata;
    fsSync.writeFileSync(recPath, JSON.stringify(rec, null, 2));

    const history = await svc.skillHistory('beta');
    expect(history.length).toBe(1);
    const entry: SkillHistoryEntry = history[0];
    expect(entry.status).toBe('published');
    expect(entry.operationId).toBe('imp-beta-legacy');
    expect(entry.version).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.basis).toBeNull(); // 缺失事实显式呈现，绝不伪造依据

    // 损坏的持久依据（无法解析为 basis）→ loud store_error，不静默降级为缺失
    rec.metadata = 'not-a-basis-json';
    rec.metadataSha256 = sha256Hex('not-a-basis-json');
    fsSync.writeFileSync(recPath, JSON.stringify(rec, null, 2));
    await expect(svc.skillHistory('beta')).rejects.toMatchObject({
      name: 'SkillVersionError',
      kind: 'store_error',
    } satisfies Partial<SkillVersionError>);
  });

  it('重启（新实例）后历史事实一致：版本/操作/依据/commit 时间逐条相同', async () => {
    seedBaseline();
    const svc1 = await makeService();
    const h = await svc1.beginEdit({ skillName: 'alpha', requestId: 'req-restart', basis: editBasis });
    writeWsFile(h, 'SKILL.md', SKILL_MD('alpha', '# Alpha v2\n'));
    const s = await svc1.submitEdit(h.editId);
    expect(s.kind).toBe('published');

    const before = await svc1.skillHistory('alpha');
    const svc2 = await makeService(); // 重启视角
    const after = await svc2.skillHistory('alpha');
    expect(after).toEqual(before);
    expect(after.find(e => e.editId === h.editId)?.version).toBe(s.kind === 'published' ? s.version : '');
  });
});
