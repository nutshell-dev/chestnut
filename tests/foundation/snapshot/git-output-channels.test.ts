/**
 * Phase 1935 Step C — 传统 Snapshot Git 协议/诊断通道分离（确定性注入）
 *
 * 命题：Snapshot.git wrapper 只消费成功结果的纯 stdout；成功 stderr 经
 * observeGitStderr 观察一次（保留原文），既不污染 status/rev-parse 解析，
 * 也不被静默丢弃、不重复发事件。
 *
 * 注入形态：output = stdout + warning（模拟真实子进程 combined 混合），
 * stdout 保持纯协议——若实现回退为消费 output，本文件用例立即变红。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Snapshot } from '../../../src/foundation/snapshot/snapshot.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';

const WARNING = 'warning: confstr(_CS_DARWIN_USER_TEMP_DIR) failed';

function makeMockFs(): FileSystem {
  return {
    exists: vi.fn((p: string) => Promise.resolve(p === '.git')),
    read: vi.fn(() => Promise.resolve('')),
    writeAtomic: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    removeDir: vi.fn(() => Promise.resolve()),
    ensureDir: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve([])),
    realpath: vi.fn((p: string) => Promise.resolve(p)),
    appendSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
    moveSync: vi.fn(),
    existsSync: vi.fn(() => true),
    listSync: vi.fn(() => []),
    readSync: vi.fn(() => ''),
    writeAtomicSync: vi.fn(),
    ensureDirSync: vi.fn(),
    deleteSync: vi.fn(),
  } as unknown as FileSystem;
}

/** 成功结果：协议纯 stdout、诊断纯 stderr、output 为两者混合（旧缺陷形态）。 */
function mixed(stdout: string, stderr: string): { output: string; stdout: string; stderr: string; exitCode: number } {
  return { output: stdout + stderr, stdout, stderr, exitCode: 0 };
}

describe('Snapshot git stdout/stderr 通道分离（phase 1935 Step C）', () => {
  let audit: ReturnType<typeof makeMockAudit>;

  beforeEach(() => {
    audit = makeMockAudit();
  });

  it('空 status stdout + 非空 stderr → 无额外 commit；诊断事件恰好一次且保留原文', async () => {
    const fs = makeMockFs();
    const execImpl = vi.fn(() => Promise.resolve(mixed('', WARNING)));
    const snapshot = new Snapshot('/tmp/agent-1935', fs, audit, [], undefined, execImpl as never);

    const r = await snapshot.commit('turn-x');
    expect(r.ok).toBe(true);

    // 关键断言：只调用了 status；若消费 combined output 会误判有变更并追加 add/commit
    expect(execImpl).toHaveBeenCalledTimes(1);
    expect((execImpl.mock.calls[0] as unknown as unknown[])[1]).toEqual(['status', '--porcelain']);

    // 诊断不被静默丢弃：恰好一条 GIT_STDERR 事件、保留原文、不重复观察
    const gitStderrCalls = (audit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === SNAPSHOT_AUDIT_EVENTS.GIT_STDERR,
    );
    expect(gitStderrCalls).toHaveLength(1);
    expect(gitStderrCalls[0]).toEqual([SNAPSHOT_AUDIT_EVENTS.GIT_STDERR, 'dir=/tmp/agent-1935', `stderr=${WARNING}`]);
  });

  it('init/HEAD 查询 stdout 合法 + 警告 → 幂等初始化成功，不把警告当 HEAD 缺失', async () => {
    const fs = makeMockFs();
    const headSha = 'a'.repeat(40);
    const execImpl = vi.fn(() => Promise.resolve(mixed(`${headSha}\n`, WARNING)));
    const snapshot = new Snapshot('/tmp/agent-1935-init', fs, audit, [], undefined, execImpl as never);

    const r = await snapshot.init();
    expect(r.ok).toBe(true);

    // 仅 rev-parse HEAD 一次；若 stdout 被 output 污染，head.stdout 非空判断仍过，
    // 但旧实现 output.trim() 含警告文本会被当成合法 SHA 掩盖——此处同时断言
    // 无 reinit（init/config/add/commit 均未调用）
    expect(execImpl).toHaveBeenCalledTimes(1);
    expect((execImpl.mock.calls[0] as unknown as unknown[])[1]).toEqual(['rev-parse', 'HEAD']);

    const gitStderrCalls = (audit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === SNAPSHOT_AUDIT_EVENTS.GIT_STDERR,
    );
    expect(gitStderrCalls).toHaveLength(1);
    expect(gitStderrCalls[0][2]).toBe(`stderr=${WARNING}`);
  });

  it('stderr 为空/缺失 → 不发诊断事件（无噪声）', async () => {
    const fs = makeMockFs();
    const execImpl = vi.fn(() => Promise.resolve({ output: '', stdout: '', exitCode: 0 }));
    const snapshot = new Snapshot('/tmp/agent-1935-quiet', fs, audit, [], undefined, execImpl as never);

    const r = await snapshot.commit('turn-quiet');
    expect(r.ok).toBe(true);
    const gitStderrCalls = (audit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === SNAPSHOT_AUDIT_EVENTS.GIT_STDERR,
    );
    expect(gitStderrCalls).toHaveLength(0);
  });

  it('诊断事件保留 stderr 原文（含前后空白），不经 wrapper trim', async () => {
    const fs = makeMockFs();
    const rawStderr = '  padded warning \n';
    const execImpl = vi.fn(() => Promise.resolve(mixed('', rawStderr)));
    const snapshot = new Snapshot('/tmp/agent-1935-raw', fs, audit, [], undefined, execImpl as never);

    await snapshot.commit('turn-raw');
    const gitStderrCalls = (audit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === SNAPSHOT_AUDIT_EVENTS.GIT_STDERR,
    );
    expect(gitStderrCalls).toHaveLength(1);
    expect(gitStderrCalls[0][2]).toBe(`stderr=${rawStderr}`);
  });
});

describe('observeGitStderr 审计失败降级（phase 1935 Step C）', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('audit.write 抛错 → fallback 保留原诊断与观察错误；Git 成功结果不被覆盖', async () => {
    const audit = makeMockAudit();
    (audit.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('audit medium broken');
    });
    const fs = makeMockFs();
    const execImpl = vi.fn(() => Promise.resolve(mixed('', WARNING)));
    const snapshot = new Snapshot('/tmp/agent-1935-auditfail', fs, audit, [], undefined, execImpl as never);

    // Git 成功值保持：commit 正常返回 ok（诊断通道故障不升级）
    const r = await snapshot.commit('turn-auditfail');
    expect(r.ok).toBe(true);

    // fallback 含原诊断及观察错误
    const fallbackLines = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('snapshot_git_stderr_audit_failed'));
    expect(fallbackLines).toHaveLength(1);
    const payload = JSON.parse(fallbackLines[0]) as { type: string; dir: string; stderr: string; error: string };
    expect(payload.dir).toBe('/tmp/agent-1935-auditfail');
    expect(payload.stderr).toBe(WARNING);
    expect(payload.error).toContain('audit medium broken');
  });
});
