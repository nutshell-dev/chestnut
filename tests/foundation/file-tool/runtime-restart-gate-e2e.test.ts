/**
 * phase 1452 (F-NEXT.3 治理): Runtime restart e2e — readFileState persist→load→gate 行为契约验证。
 *
 * 模拟 daemon 进程 A 持有 ctx A、read tool 触发 persist → 进程 A 终止 → 进程 B 启 ctx B + load 磁盘 →
 * write tool 在 ctx B 用 restored state 做 gate 决策、跨"restart"行为契约连续。
 *
 * 全 NodeFileSystem 真磁盘、非 mock = e2e 名副其实（per 编码规范「让代码经历从未走过的路径」）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { readTool, writeTool } from '../../../src/foundation/file-tool/index.js';
import {
  loadReadFileState,
  persistReadFileState,
  READ_STATE_FILE,
} from '../../../src/foundation/file-tool/file-state-persist.js';
import { FILE_TOOL_AUDIT_EVENTS } from '../../../src/foundation/file-tool/audit-events.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';

import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';

/**
 * Mtime tick guard (15ms): 等 OS mtime 精度 tick 跨过、保 fs.stat 看到 mtime 变化.
 * Derivation: > APFS/ext4 ms 级 mtime 粒度 / 跨平台 1 tick safety margin.
 */
const MTIME_TICK_GUARD_MS = 15;

interface E2eCtx {
  ctx: ExecContextImpl;
  audit: ReturnType<typeof makeAudit>;
}

async function makeCtx(clawDir: string, persist: boolean): Promise<E2eCtx> {
  const audit = makeAudit();
  const nfs = new NodeFileSystem({ baseDir: clawDir });
  const ctx = new ExecContextImpl({
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    clawId: 'test-claw',
    clawDir,
    syncDir: path.join(clawDir, 'tasks', 'sync'),
    profile: 'full',
    fs: nfs,
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    permissionChecker: createClawPermissionChecker({ clawDir, strict: true }),
    auditWriter: audit.audit,
    persistReadFileState: persist,
    maxSteps: 20,
  });
  return { ctx, audit };
}

describe('Runtime restart gate e2e (phase 1452 / F-NEXT.3)', () => {
  let clawDir: string;

  beforeEach(async () => {
    clawDir = await createTempDir();
    await fs.mkdir(path.join(clawDir, 'clawspace'), { recursive: true });
    await fs.mkdir(path.join(clawDir, 'tasks', 'sync'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(clawDir);
  });

  it('case 1: Runtime A read → disk persist → Runtime B load → state map matches', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace/small.md'), 'hello world');

    // Runtime A：read 触发 persist (fire-and-forget in helper; await explicitly for deterministic e2e)
    const { ctx: ctxA } = await makeCtx(clawDir, true);
    const readRes = await readTool.execute({ path: 'small.md' }, ctxA);
    expect(readRes.success).toBe(true);
    await persistReadFileState(ctxA);  // flush async persist for test determinism

    const stateA = ctxA.readFileState.get('clawspace/small.md');
    expect(stateA?.isFullRead).toBe(true);
    expect(stateA?.hash).toMatch(/^[a-f0-9]{64}$/);  // SHA-256 hex

    // 磁盘 verify
    const diskRaw = await fs.readFile(path.join(clawDir, READ_STATE_FILE), 'utf-8');
    const onDisk = JSON.parse(diskRaw);
    expect(onDisk.version).toBe(1);
    expect(onDisk.entries['clawspace/small.md']).toEqual(stateA);

    // Runtime B：fresh ctx + load
    const { ctx: ctxB, audit: auditB } = await makeCtx(clawDir, true);
    ctxB.readFileState = await loadReadFileState(ctxB.fs, ctxB.auditWriter);

    expect(ctxB.readFileState.get('clawspace/small.md')).toEqual(stateA);
    const loadAudits = auditB.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED);
    expect(loadAudits.length).toBe(1);
    expect(loadAudits[0].join(' ')).toMatch(/result=ok entry_count=1/);
  });

  it('case 2: Runtime B accepts overwrite after Runtime A full-read (hash matches, gate pass)', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace/x.md'), 'v1');

    // A: full read
    const { ctx: ctxA } = await makeCtx(clawDir, true);
    await readTool.execute({ path: 'x.md' }, ctxA);
    await persistReadFileState(ctxA);  // flush

    // B: load + overwrite
    const { ctx: ctxB } = await makeCtx(clawDir, true);
    ctxB.readFileState = await loadReadFileState(ctxB.fs, ctxB.auditWriter);

    const writeRes = await writeTool.execute({ path: 'x.md', content: 'v2 from runtime B' }, ctxB);
    expect(writeRes.success).toBe(true);

    const onDiskContent = await fs.readFile(path.join(clawDir, 'clawspace/x.md'), 'utf-8');
    expect(onDiskContent).toBe('v2 from runtime B');
  });

  it('case 3: Runtime B rejects overwrite when file modified externally between restarts (reason=stale)', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace/y.md'), 'original');

    // A: read
    const { ctx: ctxA } = await makeCtx(clawDir, true);
    await readTool.execute({ path: 'y.md' }, ctxA);
    await persistReadFileState(ctxA);  // flush

    // external modify between A teardown and B startup
    await new Promise(r => setTimeout(r, MTIME_TICK_GUARD_MS));  // mtime tick guard (cross-platform ms precision)
    await fs.writeFile(path.join(clawDir, 'clawspace/y.md'), 'externally modified');

    // B: load + attempt overwrite
    const { ctx: ctxB, audit: auditB } = await makeCtx(clawDir, true);
    ctxB.readFileState = await loadReadFileState(ctxB.fs, ctxB.auditWriter);

    const writeRes = await writeTool.execute({ path: 'y.md', content: 'v2 attempt' }, ctxB);
    expect(writeRes.success).toBe(false);
    expect(writeRes.content).toMatch(/modified since/);

    const gateAudits = auditB.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.OVERWRITE_GATE_REJECTED);
    expect(gateAudits.length).toBe(1);
    expect(gateAudits[0].join(' ')).toMatch(/reason=stale/);
  });

  it('case 4: Runtime B rejects overwrite when Runtime A only partial-read (isFullRead=false preserved)', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n');
    await fs.writeFile(path.join(clawDir, 'clawspace/long.md'), lines);

    // A: partial read (offset 10, limit 5 → not full)
    const { ctx: ctxA } = await makeCtx(clawDir, true);
    await readTool.execute({ path: 'long.md', offset: 10, limit: 5 }, ctxA);
    await persistReadFileState(ctxA);  // flush
    const stateA = ctxA.readFileState.get('clawspace/long.md');
    expect(stateA?.isFullRead).toBe(false);

    // B: load + attempt overwrite
    const { ctx: ctxB, audit: auditB } = await makeCtx(clawDir, true);
    ctxB.readFileState = await loadReadFileState(ctxB.fs, ctxB.auditWriter);

    expect(ctxB.readFileState.get('clawspace/long.md')?.isFullRead).toBe(false);

    const writeRes = await writeTool.execute({ path: 'long.md', content: 'wipe' }, ctxB);
    expect(writeRes.success).toBe(false);
    expect(writeRes.content).toMatch(/not been fully read/);

    const gateAudits = auditB.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.OVERWRITE_GATE_REJECTED);
    expect(gateAudits.length).toBe(1);
    expect(gateAudits[0].join(' ')).toMatch(/reason=partial/);
  });

  it('case 5: Runtime B fails-safe on corrupt disk file (load returns empty + audit + gate rejects as not-read)', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace/z.md'), 'v1');
    await fs.writeFile(path.join(clawDir, READ_STATE_FILE), '{not valid json');

    // B: load corrupt
    const { ctx: ctxB, audit: auditB } = await makeCtx(clawDir, true);
    ctxB.readFileState = await loadReadFileState(ctxB.fs, ctxB.auditWriter);

    expect(ctxB.readFileState.size).toBe(0);
    const loadAudits = auditB.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED);
    expect(loadAudits.length).toBe(1);
    expect(loadAudits[0].join(' ')).toMatch(/result=parse_failed/);

    // gate rejects as "never read"（fail-safe → claw 必须重 read）
    const writeRes = await writeTool.execute({ path: 'z.md', content: 'v2 attempt' }, ctxB);
    expect(writeRes.success).toBe(false);
    expect(writeRes.content).toMatch(/not been fully read/);

    const gateAudits = auditB.events.filter(e => e[0] === FILE_TOOL_AUDIT_EVENTS.OVERWRITE_GATE_REJECTED);
    expect(gateAudits.length).toBe(1);
    expect(gateAudits[0].join(' ')).toMatch(/reason=not-read/);
  });

  it('case 6: subagent ctx (persistReadFileState=false) does NOT create disk file even after reads', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace/sub.md'), 'subagent content');

    const { ctx: subCtx } = await makeCtx(clawDir, false);  // persist disabled
    const readRes = await readTool.execute({ path: 'sub.md' }, subCtx);
    expect(readRes.success).toBe(true);
    expect(subCtx.readFileState.size).toBe(1);  // in-memory only

    const diskExists = await fs.access(path.join(clawDir, READ_STATE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(diskExists).toBe(false);
  });
});
