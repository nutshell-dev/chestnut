/**
 * Phase 1923 Step C：依据准入与补依据重提（SkillVersions，真实 Git）。
 *
 * 验收（Phase 1922 业务决策：依据是发布前置条件，占位身份不得完成发布）：
 * - 未归因依据（actor=unattributed/unspecified、空白 reason）submit → typed
 *   basis_required：不推进 published、候选与 saved 状态保留、不占发布幂等键；
 * - amendEditBasis 原地补依据：候选内容不变、派生新 publishOperationId（与旧
 *   失败尝试区分），补后可发布且版本只提交一次；同 requestId 重放幂等、
 *   输入漂移 typed 拒绝；
 * - 负向：已可归因依据不可 amend（busy/并发窗口幂等键输入保护）、非 saved
 *   状态不可 amend、占位/空白补充依据拒绝（不默默补默认理由）；
 * - 重启（新实例）后可补依据并重提成功；补依据重提遇并发发布仍 typed conflict。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import {
  createSkillVersions,
  type SkillBasis,
  type SkillEditHandle,
  type SkillVersions,
} from '../../../src/foundation/skill-system/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const SKILL_MD = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`;
const orphanBasis: SkillBasis = { actor: 'unattributed', reason: 'orphan env task', sourceRefs: [] };
const goodBasis: SkillBasis = { actor: 'subagent:retro9', reason: 'retro improvement', sourceRefs: ['subagent-task:t-9'] };

describe.skipIf(!gitAvailable)('SkillVersions 依据准入与补依据重提（Phase 1923 Step C）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-basis-');
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

  function writeWsFile(handle: SkillEditHandle, rel: string, content: string): void {
    const abs = path.join(handle.path, rel);
    fsSync.mkdirSync(path.dirname(abs), { recursive: true });
    fsSync.writeFileSync(abs, content);
  }

  it('未归因依据 submit → basis_required：published 不推进、候选/saved 保留、不占发布幂等键', async () => {
    seedBaseline();
    const svc = await makeService();
    const before = await svc.readPublished('alpha');

    const h = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-orphan', basis: orphanBasis });
    writeWsFile(h, 'SKILL.md', SKILL_MD('alpha', '# Alpha orphan\n'));
    const r = await svc.submitEdit(h.editId);

    expect(r.kind).toBe('basis_required');
    if (r.kind !== 'basis_required') throw new Error('unreachable');
    expect(r.candidate).toMatch(/^[0-9a-f]{40}$/);

    // published 未推进；事务保留 saved + 候选；发布幂等键未占用（准入先于落盘）
    expect((await svc.readPublished('alpha')).sourceVersion).toBe(before.sourceVersion);
    const info = await svc.editStatus(h.editId);
    expect(info.status).toBe('saved');
    expect(info.candidate).toBe(r.candidate);
    expect(info.publishOperationId).toBeNull();
    expect(info.basis).toEqual(orphanBasis);
  });

  it.each([
    ['unspecified', { actor: 'unspecified', reason: 'x', sourceRefs: [] }],
    ['空白 reason', { actor: 'user', reason: '   ', sourceRefs: [] }],
    ['大小写变体', { actor: ' UnAttributed ', reason: 'x', sourceRefs: [] }],
  ])('占位/空白依据同样被拒：%s', async (_label, basis) => {
    seedBaseline();
    const svc = await makeService();
    // validateBasis 只校验形状（reason 为字符串），空白 reason 可 begin 但过不了发布准入
    const h = await svc.beginEdit({ skillName: 'alpha', requestId: `req-${_label}`, basis });
    writeWsFile(h, 'SKILL.md', SKILL_MD('alpha', '# Alpha placeholder\n'));
    const r = await svc.submitEdit(h.editId);
    expect(r.kind).toBe('basis_required');
  });

  it('补依据重提：候选不变、新发布幂等键、版本只提交一次；重放幂等/漂移拒绝', async () => {
    seedBaseline();
    const svc = await makeService();
    const h = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-amend', basis: orphanBasis });
    writeWsFile(h, 'SKILL.md', SKILL_MD('alpha', '# Alpha amended\n'));
    const blocked = await svc.submitEdit(h.editId);
    expect(blocked.kind).toBe('basis_required');

    // 补充依据本身也必须可归因（不默默补默认理由）
    await expect(svc.amendEditBasis({
      editId: h.editId, requestId: 'amend-bad', basis: { actor: 'unattributed', reason: 'still orphan', sourceRefs: [] },
    })).rejects.toMatchObject({ kind: 'invalid_argument' });

    const amended = await svc.amendEditBasis({ editId: h.editId, requestId: 'amend-1', basis: goodBasis });
    expect(amended.status).toBe('saved');
    expect(amended.basis).toEqual(goodBasis);
    expect(amended.candidate).toBe(blocked.kind === 'basis_required' ? blocked.candidate : '');
    // 新发布幂等键与旧失败尝试区分（旧尝试未占键；补充派生 amend 序号键）
    expect(amended.publishOperationId).toBe(`edit-publish-${h.editId}-amend0`);

    // 同 requestId 重放：返回首次补充事实；漂移 typed 拒绝
    const replay = await svc.amendEditBasis({ editId: h.editId, requestId: 'amend-1', basis: goodBasis });
    expect(replay.publishOperationId).toBe(amended.publishOperationId);
    await expect(svc.amendEditBasis({
      editId: h.editId, requestId: 'amend-1', basis: { ...goodBasis, reason: 'drifted' },
    })).rejects.toMatchObject({ kind: 'invalid_argument' });

    // 重提发布：版本只提交一次（重复 submit 返回首次发布事实）
    const s1 = await svc.submitEdit(h.editId);
    expect(s1.kind).toBe('published');
    const s2 = await svc.submitEdit(h.editId);
    expect(s2).toEqual(s1);
    expect(await svc.loadPublished('alpha')).toContain('# Alpha amended');

    // Snapshot 历史：该编辑只有一次发布提交，依据为补充后的完整依据
    const history = await svc.skillHistory('alpha');
    const publishedEntries = history.filter(e => e.editId === h.editId && e.status === 'published');
    expect(publishedEntries.length).toBe(1);
    expect(publishedEntries[0].operationId).toBe(`edit-publish-${h.editId}-amend0`);
    expect(publishedEntries[0].basis).toEqual(goodBasis);
  });

  it('门禁：已可归因依据/非 saved 状态不得 amend（保护既有发布幂等键输入）', async () => {
    seedBaseline();
    const svc = await makeService();

    // 已发布编辑（终态）不得 amend
    const good = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-good', basis: goodBasis });
    writeWsFile(good, 'SKILL.md', SKILL_MD('alpha', '# Alpha good\n'));
    // editing 状态（未保存候选）不得 amend
    await expect(svc.amendEditBasis({ editId: good.editId, requestId: 'amend-x', basis: goodBasis }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    const s = await svc.submitEdit(good.editId);
    expect(s.kind).toBe('published');
    await expect(svc.amendEditBasis({ editId: good.editId, requestId: 'amend-y', basis: goodBasis }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });

    // cancelled 不得 amend
    const c = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-cancel', basis: orphanBasis });
    await svc.cancelEdit(c.editId);
    await expect(svc.amendEditBasis({ editId: c.editId, requestId: 'amend-z', basis: goodBasis }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });

    // 依据已可归因的 saved 编辑不得 amend（busy/并发窗口保护）
    const orphan = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-orphan2', basis: orphanBasis });
    writeWsFile(orphan, 'SKILL.md', SKILL_MD('alpha', '# Alpha orphan2\n'));
    const blocked = await svc.submitEdit(orphan.editId);
    expect(blocked.kind).toBe('basis_required');
    await svc.amendEditBasis({ editId: orphan.editId, requestId: 'amend-ok', basis: goodBasis });
    // 补过后依据已可归因：再次 amend（新 requestId）拒绝——应重提 submit
    await expect(svc.amendEditBasis({ editId: orphan.editId, requestId: 'amend-again', basis: goodBasis }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
  });

  it('重启恢复：basis_required 状态跨重启可查可补，补后重提成功', async () => {
    seedBaseline();
    const svc1 = await makeService();
    const h = await svc1.beginEdit({ skillName: 'alpha', requestId: 'req-restart', basis: orphanBasis });
    writeWsFile(h, 'SKILL.md', SKILL_MD('alpha', '# Alpha restart\n'));
    const blocked = await svc1.submitEdit(h.editId);
    expect(blocked.kind).toBe('basis_required');

    const svc2 = await makeService(); // 重启视角：状态与候选可恢复查询
    const info = await svc2.editStatus(h.editId);
    expect(info.status).toBe('saved');
    expect(info.candidate).toBe(blocked.kind === 'basis_required' ? blocked.candidate : '');
    await svc2.amendEditBasis({ editId: h.editId, requestId: 'amend-restart', basis: goodBasis });
    const s = await svc2.submitEdit(h.editId);
    expect(s.kind).toBe('published');
    expect(await svc2.loadPublished('alpha')).toContain('# Alpha restart');
  });

  it('补依据重提遇并发发布：仍 typed conflict，候选保留不覆盖', async () => {
    seedBaseline();
    const svc = await makeService();
    const orphan = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-race-orphan', basis: orphanBasis });
    writeWsFile(orphan, 'SKILL.md', SKILL_MD('alpha', '# Alpha by orphan\n'));
    const blocked = await svc.submitEdit(orphan.editId);
    expect(blocked.kind).toBe('basis_required');

    // 他人（可归因编辑）先行发布
    const other = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-race-other', basis: goodBasis });
    writeWsFile(other, 'SKILL.md', SKILL_MD('alpha', '# Alpha by other\n'));
    const so = await svc.submitEdit(other.editId);
    expect(so.kind).toBe('published');

    // 补依据后重提：基准已过期 → conflict（不改变既有 conflict 语义）
    await svc.amendEditBasis({ editId: orphan.editId, requestId: 'amend-race', basis: goodBasis });
    const r = await svc.submitEdit(orphan.editId);
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') {
      expect(r.candidate).toBe(blocked.kind === 'basis_required' ? blocked.candidate : '');
      expect(r.current).toBe(so.kind === 'published' ? so.version : '');
    }
    expect(await svc.loadPublished('alpha')).toContain('# Alpha by other');
  });
});
