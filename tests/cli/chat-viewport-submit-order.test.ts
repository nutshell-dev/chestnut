/**
 * phase 1874 Step C (cli-viewport-draft-cleared-before-commit): 用户消息提交序行为矩阵。
 *
 * 事故形态（2026-09-13）：pi-tui `Editor.submitValue` 先 `onChange('')` 清磁盘草稿、
 * 后 `onSubmit` → 入队失败时编辑器与草稿皆空。时序归 pi-tui 不可改 → 提交核心事后保全：
 * ① 写入成功 → 显式清草稿（reason=submitted、inbox 已持权威副本）
 * ② 写入失败 → 草稿保留 pending 副本（磁盘侧可恢复）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { submitUserMessage } from '../../src/viewport/chat-viewport-utils.js';
import { clearViewportDraft, loadViewportDraft, VIEWPORT_DRAFT_FILE } from '../../src/viewport/chat-viewport-draft.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createViewportAudit } from '../../src/viewport/viewport-audit-events.js';

describe('phase 1874 Step C: submit draft order', () => {
  let tempDir: string;
  let originalEnv: string | undefined;
  let agentDir: string;
  let fsImpl: NodeFileSystem;
  let audit: ReturnType<typeof createViewportAudit>;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('phase1874c-');
    originalEnv = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
    agentDir = path.join(tempDir, '.chestnut', 'motion');
    fs.mkdirSync(path.join(agentDir, 'inbox', 'pending'), { recursive: true });
    fsImpl = new NodeFileSystem({ baseDir: agentDir });
    audit = createViewportAudit(fsImpl, agentDir);
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalEnv;
    await cleanupTempDir(tempDir);
  });

  const okFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

  it('① 写入成功 → 草稿清除（reason=submitted）+ inbox 落盘', () => {
    // 模拟 pi-tui 时序：提交前 onChange('') 已清草稿
    clearViewportDraft(fsImpl, audit, 'explicit_empty_state');
    expect(fsImpl.existsSync(VIEWPORT_DRAFT_FILE)).toBe(false);

    const outcome = submitUserMessage(
      { agentDir, fs: fsImpl, audit, fsFactory: okFactory },
      'hello inbox',
    );

    expect(outcome).toEqual({ ok: true });
    // 成功不残留 pending 草稿（inbox 已持权威副本）
    expect(fsImpl.existsSync(VIEWPORT_DRAFT_FILE)).toBe(false);
    expect(loadViewportDraft(fsImpl, audit)).toEqual({ kind: 'none' });

    const viewportTsv = fs.readFileSync(path.join(agentDir, 'viewport.tsv'), 'utf-8');
    expect(viewportTsv).toContain('viewport_draft_cleared');
    expect(viewportTsv).toContain('reason=submitted');

    const inboxFiles = fs.readdirSync(path.join(agentDir, 'inbox', 'pending'));
    expect(inboxFiles).toHaveLength(1);
    expect(fs.readFileSync(path.join(agentDir, 'inbox', 'pending', inboxFiles[0]), 'utf-8'))
      .toContain('hello inbox');
  });

  it('② 写入失败 → 草稿保留 pending 副本（磁盘侧可恢复）+ outcome.ok=false', () => {
    clearViewportDraft(fsImpl, audit, 'explicit_empty_state');
    const failingFactory = () => { throw new Error('disk down'); };

    const outcome = submitUserMessage(
      { agentDir, fs: fsImpl, audit, fsFactory: failingFactory },
      'precious input',
    );

    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('disk down') });
    // 磁盘草稿 = 本次提交文本（恢复副本）——事故形态（两者皆空）不再出现
    expect(loadViewportDraft(fsImpl, audit)).toEqual({ kind: 'restored', text: 'precious input' });

    const viewportTsv = fs.readFileSync(path.join(agentDir, 'viewport.tsv'), 'utf-8');
    expect(viewportTsv).not.toContain('reason=submitted');
  });

  it('③ 正常提交（无预清草稿）→ 行为同 ①：成功后零残留草稿', () => {
    // 防御性场景：即便提交前草稿未被 onChange 清除，成功提交也不残留 pending 副本
    const outcome = submitUserMessage(
      { agentDir, fs: fsImpl, audit, fsFactory: okFactory },
      'direct submit',
    );

    expect(outcome).toEqual({ ok: true });
    expect(loadViewportDraft(fsImpl, audit)).toEqual({ kind: 'none' });
  });
});
