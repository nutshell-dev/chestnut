/**
 * phase 1452 (F-NEXT.4 治理): performRegimeSwitch + readFileState clear hook 端到端验证。
 *
 * phase 1443 已落:
 *   - PerformRegimeSwitchOpts 新增 onSwitchComplete? callback
 *   - performRegimeSwitch 末尾 await onSwitchComplete?.()
 *   - Runtime._performRegimeSwitch 注入 () => clearReadFileState(this.execContext)
 *
 * 本 phase 验证:
 *   1. 当 performRegimeSwitch 成功提交时、onSwitchComplete 被调用
 *   2. clearReadFileState 真清 in-memory Map + 删 disk file
 *   3. 跨 regime switch 的 gate 决策连续性：清后下次 overwrite 必拒（reason=not-read）
 *
 * 实施模式：直接调 performRegimeSwitch（不构造 Runtime 整体）+ 真 NodeFileSystem + 最小 mock DialogStore。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { readTool, writeTool } from '../../../src/foundation/file-tool/index.js';
import {
  persistReadFileState,
  clearReadFileState,
  READ_STATE_FILE,
} from '../../../src/foundation/file-tool/file-state-persist.js';
import { FILE_TOOL_AUDIT_EVENTS } from '../../../src/foundation/file-tool/audit-events.js';
import { performRegimeSwitch } from '../../../src/foundation/dialog-store/index.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';

import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';

interface E2eCtx {
  ctx: ExecContextImpl;
  audit: ReturnType<typeof makeAudit>;
}

async function makeCtx(clawDir: string): Promise<E2eCtx> {
  const audit = makeAudit();
  const nfs = new NodeFileSystem({ baseDir: clawDir });
  const ctx = new ExecContextImpl({
    clawsDir: '/tmp/test/claws',
    clawId: 'test-claw',
    clawDir,
    syncDir: path.join(clawDir, 'tasks', 'sync'),
    profile: 'full',
    fs: nfs,
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
    auditWriter: audit.audit,
    persistReadFileState: true,
    maxSteps: 20,
  });
  return { ctx, audit };
}

function makeMockDialogStore(): DialogStore {
  return {
    load: vi.fn().mockResolvedValue({
      session: {
        version: 2,
        systemPrompt: 'old prompt',
        messages: [{ role: 'user', content: 'msg1' }],
        toolsForLLM: [],
      },
      source: 'current',
    }),
    save: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    getFlushPromise: vi.fn().mockResolvedValue(undefined),
    beginTurn: vi.fn().mockResolvedValue(undefined),
    commitTurn: vi.fn().mockResolvedValue(undefined),
    rollbackTurn: vi.fn().mockResolvedValue(undefined),
  } as unknown as DialogStore;
}

const RGS_AUDIT_EVENTS = {
  REGIME_SWITCH: 'regime_switch',
  REGIME_SWITCH_COMMITTED: 'regime_switch_committed',
  REGIME_SWITCH_FAILED: 'regime_switch_failed',
  REGIME_SWITCH_HARD_FAIL: 'regime_switch_hard_fail',
};

describe('performRegimeSwitch + readFileState clear hook e2e (phase 1452 / F-NEXT.4)', () => {
  let clawDir: string;

  beforeEach(async () => {
    clawDir = await createTempDir();
    await fs.mkdir(path.join(clawDir, 'clawspace'), { recursive: true });
    await fs.mkdir(path.join(clawDir, 'tasks', 'sync'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(clawDir);
  });

  it('case 1: onSwitchComplete callback fires after successful regime switch; clears in-memory Map + disk file', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace/note.md'), 'before switch');

    // populate ctx state via real read + persist
    const { ctx } = await makeCtx(clawDir);
    await readTool.execute({ path: 'note.md' }, ctx);
    await persistReadFileState(ctx);

    expect(ctx.readFileState.size).toBe(1);
    const diskBefore = await fs.access(path.join(clawDir, READ_STATE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(diskBefore).toBe(true);

    // run regime switch with the wired onSwitchComplete = clearReadFileState
    const callbackFired = { value: false };
    const currentStore = makeMockDialogStore();
    const newStore = makeMockDialogStore();

    await performRegimeSwitch({
      strategy: 'last-turn',
      newSystemPrompt: 'new prompt',
      currentStore,
      dialogStoreFactory: () => newStore,
      toolsForLLM: [],
      clawDir,
      systemFs: ctx.fs,
      audit: ctx.auditWriter!,
      auditEvents: RGS_AUDIT_EVENTS,
      onSwitchComplete: async () => {
        callbackFired.value = true;
        await clearReadFileState(ctx);
      },
    });

    expect(callbackFired.value).toBe(true);
    expect(ctx.readFileState.size).toBe(0);

    const diskAfter = await fs.access(path.join(clawDir, READ_STATE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(diskAfter).toBe(false);
  });

  it('case 2: after regime switch, next overwrite is rejected (gate state purged, reason=not-read)', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace/doc.md'), 'doc v1');

    const { ctx, audit } = await makeCtx(clawDir);
    await readTool.execute({ path: 'doc.md' }, ctx);
    await persistReadFileState(ctx);

    // pre-switch: gate would accept overwrite
    expect(ctx.readFileState.get('clawspace/doc.md')?.isFullRead).toBe(true);

    // regime switch with cleanup hook
    await performRegimeSwitch({
      strategy: 'last-turn',
      newSystemPrompt: 'new',
      currentStore: makeMockDialogStore(),
      dialogStoreFactory: () => makeMockDialogStore(),
      toolsForLLM: [],
      clawDir,
      systemFs: ctx.fs,
      audit: ctx.auditWriter!,
      auditEvents: RGS_AUDIT_EVENTS,
      onSwitchComplete: () => clearReadFileState(ctx),
    });

    // post-switch: gate must reject overwrite (state purged)
    const writeRes = await writeTool.execute({ path: 'doc.md', content: 'post-switch attack' }, ctx);
    expect(writeRes.success).toBe(false);
    expect(writeRes.content).toMatch(/not been fully read/);

    const gateAudits = audit.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.OVERWRITE_GATE_REJECTED);
    expect(gateAudits.length).toBe(1);
    expect(gateAudits[0].join(' ')).toMatch(/reason=not-read/);

    // 文件磁盘内容未变（写被拒）
    const onDisk = await fs.readFile(path.join(clawDir, 'clawspace/doc.md'), 'utf-8');
    expect(onDisk).toBe('doc v1');
  });

  it('case 3: onSwitchComplete callback NOT invoked when regime switch hard-fails (archive throw)', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace/keep.md'), 'before fail');

    const { ctx } = await makeCtx(clawDir);
    await readTool.execute({ path: 'keep.md' }, ctx);
    await persistReadFileState(ctx);

    expect(ctx.readFileState.size).toBe(1);

    // archive throw → regime switch fails before reaching onSwitchComplete
    const failingStore = makeMockDialogStore();
    (failingStore.archive as any).mockRejectedValueOnce(new Error('archive disk full'));

    const callbackFired = { value: false };
    await expect(
      performRegimeSwitch({
        strategy: 'last-turn',
        newSystemPrompt: 'new',
        currentStore: failingStore,
        dialogStoreFactory: () => makeMockDialogStore(),
        toolsForLLM: [],
        clawDir,
        systemFs: ctx.fs,
        audit: ctx.auditWriter!,
        auditEvents: RGS_AUDIT_EVENTS,
        onSwitchComplete: async () => {
          callbackFired.value = true;
          await clearReadFileState(ctx);
        },
      }),
    ).rejects.toThrow(/archive disk full/);

    // 失败路径：onSwitchComplete 0 触发、ctx state 不动、disk file 不动
    expect(callbackFired.value).toBe(false);
    expect(ctx.readFileState.size).toBe(1);
    const diskExists = await fs.access(path.join(clawDir, READ_STATE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(diskExists).toBe(true);
  });
});
