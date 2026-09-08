/**
 * Phase 1810 Step B (MEMORY-DEEP-STATE-CORRUPT-OVERWRITE): dream state 损坏
 * raw retention / quarantine / reset gate 专测。
 *
 * 锁定语义：
 * - malformed（parse/shape 损坏）→ degraded + 原子 quarantine（rename 唯一后缀），
 *   raw 原文保留、canonical 不存在 → 后续 save 不可能覆盖原始证据；
 * - 重复损坏幂等：.corrupt-N 递增，不覆盖历史 quarantine 文件；
 * - quarantine 失败 → 原文件不动、绝不因隔离失败覆盖 raw；
 * - unavailable（EACCES 等 IO 故障）→ degraded，不 quarantine、不写文件；
 * - reset gate：只有 quarantine 保全证据后的 absent 路径才建立新 canonical state；
 * - run 级 gate：random-dream pulse 见 degraded 即 blocked 返回，不 schedule、不 save。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { createTempDir } from '../../utils/temp.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import {
  __test_loadDreamState,
  __test_saveDreamState,
  __test_DEEP_DREAM_STATE_FILE,
} from '../../../src/core/memory/deep-dream.js';
import {
  __test_loadRandomDreamState,
  __test_RANDOM_DREAM_STATE_FILE,
  runRandomDream,
} from '../../../src/core/memory/random-dream.js';
import type { RandomDreamOptions } from '../../../src/core/memory/random-dream.js';

describe('phase 1810: dream state corrupt retention（真实 fs）', () => {
  it('deep corrupt → degraded malformed，raw 随 rename 保留、canonical 消失', async () => {
    const dir = await createTempDir();
    const fs = new NodeFileSystem({ baseDir: dir });
    const raw = '{ "lastProcessedDeepDreamAt": 123, corrupt';
    writeFileSync(path.join(dir, __test_DEEP_DREAM_STATE_FILE), raw);
    const audit = makeMockAudit();

    const result = __test_loadDreamState(fs, audit, 'claw-x');

    expect(result.status).toBe('degraded');
    if (result.status !== 'degraded') throw new Error('expected degraded');
    if (result.degraded.cause !== 'malformed') throw new Error('expected malformed');
    expect(result.degraded.quarantine).toEqual({
      kind: 'quarantined',
      path: `${__test_DEEP_DREAM_STATE_FILE}.corrupt-1`,
    });
    // raw 原文逐字节保留在 quarantine 路径；canonical 已不存在
    expect(readFileSync(path.join(dir, `${__test_DEEP_DREAM_STATE_FILE}.corrupt-1`), 'utf8')).toBe(raw);
    expect(existsSync(path.join(dir, __test_DEEP_DREAM_STATE_FILE))).toBe(false);
    // audit 携带 cause=malformed + quarantine 路径证据
    const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.DEEP_DREAM_ERROR);
    expect(call).toEqual(expect.arrayContaining([
      expect.stringMatching(/^step=load_state$/),
      expect.stringMatching(/^cause=malformed$/),
      expect.stringMatching(/^quarantine=\.deep-dream-state\.json\.corrupt-1$/),
    ]));
  });

  it('重复损坏幂等：.corrupt-2 不覆盖 .corrupt-1 的历史 raw', async () => {
    const dir = await createTempDir();
    const fs = new NodeFileSystem({ baseDir: dir });
    const audit = makeMockAudit();
    const raw1 = 'corrupt-payload-v1';
    const raw2 = 'corrupt-payload-v2';

    writeFileSync(path.join(dir, __test_DEEP_DREAM_STATE_FILE), raw1);
    const first = __test_loadDreamState(fs, audit, 'claw-x');
    expect(first.status).toBe('degraded');

    // 下一轮：新 canonical 再次损坏 → quarantine 走递增后缀
    writeFileSync(path.join(dir, __test_DEEP_DREAM_STATE_FILE), raw2);
    const second = __test_loadDreamState(fs, audit, 'claw-x');
    expect(second.status).toBe('degraded');
    if (second.status !== 'degraded') throw new Error('expected degraded');
    if (second.degraded.cause !== 'malformed') throw new Error('expected malformed');
    expect(second.degraded.quarantine).toEqual({
      kind: 'quarantined',
      path: `${__test_DEEP_DREAM_STATE_FILE}.corrupt-2`,
    });
    expect(readFileSync(path.join(dir, `${__test_DEEP_DREAM_STATE_FILE}.corrupt-1`), 'utf8')).toBe(raw1);
    expect(readFileSync(path.join(dir, `${__test_DEEP_DREAM_STATE_FILE}.corrupt-2`), 'utf8')).toBe(raw2);
  });

  it('reset gate：quarantine 后 absent 路径才能建立新 canonical，quarantine 证据不被覆盖', async () => {
    const dir = await createTempDir();
    const fs = new NodeFileSystem({ baseDir: dir });
    const audit = makeMockAudit();
    const raw = 'corrupt-original-evidence';
    writeFileSync(path.join(dir, __test_DEEP_DREAM_STATE_FILE), raw);

    const degraded = __test_loadDreamState(fs, audit, 'claw-x');
    expect(degraded.status).toBe('degraded');

    // 下一轮：canonical 已 quarantine 走 → absent → ready default（显式 reset 入口）
    const next = __test_loadDreamState(fs, audit, 'claw-x');
    expect(next.status).toBe('ready');
    if (next.status !== 'ready') throw new Error('expected ready');
    expect(next.state.lastProcessedDeepDreamAt).toBe(0);

    // 新 canonical 建立；原始证据文件保持完整
    const saved = __test_saveDreamState(fs, next.state, audit, 'claw-x');
    expect(saved).toBe(true);
    expect(existsSync(path.join(dir, __test_DEEP_DREAM_STATE_FILE))).toBe(true);
    expect(readFileSync(path.join(dir, `${__test_DEEP_DREAM_STATE_FILE}.corrupt-1`), 'utf8')).toBe(raw);
  });

  it('random corrupt → degraded malformed + quarantine 保留 raw', async () => {
    const dir = await createTempDir();
    const fs = new NodeFileSystem({ baseDir: dir });
    const raw = 'not-json-at-all';
    writeFileSync(path.join(dir, __test_RANDOM_DREAM_STATE_FILE), raw);
    const audit = makeMockAudit();

    const { degraded } = __test_loadRandomDreamState(fs, audit);

    expect(degraded?.cause).toBe('malformed');
    if (degraded?.cause !== 'malformed') throw new Error('expected malformed');
    expect(degraded.quarantine.kind).toBe('quarantined');
    expect(readFileSync(path.join(dir, `${__test_RANDOM_DREAM_STATE_FILE}.corrupt-1`), 'utf8')).toBe(raw);
    expect(existsSync(path.join(dir, __test_RANDOM_DREAM_STATE_FILE))).toBe(false);
    const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR);
    expect(call).toEqual(expect.arrayContaining([
      expect.stringMatching(/^site=load_state$/),
      expect.stringMatching(/^cause=malformed$/),
    ]));
  });

  it.each(['42', '"just-a-string"', '[]'])('random 非 object JSON（%s）→ malformed quarantine（不再隐式 default）', async (content) => {
    const dir = await createTempDir();
    const fs = new NodeFileSystem({ baseDir: dir });
    writeFileSync(path.join(dir, __test_RANDOM_DREAM_STATE_FILE), content);
    const audit = makeMockAudit();

    const { degraded } = __test_loadRandomDreamState(fs, audit);

    expect(degraded?.cause).toBe('malformed');
    if (degraded?.cause !== 'malformed') throw new Error('expected malformed');
    expect(degraded.error).toMatch(/^state_not_object:/);
    expect(degraded.quarantine.kind).toBe('quarantined');
    expect(readFileSync(path.join(dir, `${__test_RANDOM_DREAM_STATE_FILE}.corrupt-1`), 'utf8')).toBe(content);
  });
});

describe('phase 1810: 故障注入（mock fs）', () => {
  it('quarantine 失败 → degraded 携 failed 证据，原文件不被覆盖', async () => {
    const raw = 'corrupt-but-must-survive';
    const fs = {
      readSync: vi.fn(() => raw),
      existsSync: vi.fn(() => false),
      moveSync: vi.fn(() => { throw new Error('EROFS: read-only file system'); }),
      writeAtomicSync: vi.fn(() => {}),
    } as unknown as FileSystem;
    const audit = makeMockAudit();

    const result = __test_loadDreamState(fs, audit, 'claw-x');

    expect(result.status).toBe('degraded');
    if (result.status !== 'degraded') throw new Error('expected degraded');
    if (result.degraded.cause !== 'malformed') throw new Error('expected malformed');
    expect(result.degraded.quarantine).toEqual({
      kind: 'failed',
      error: 'EROFS: read-only file system',
    });
    // 隔离失败也不写 canonical——原文件证据仍在（readSync 原样返回 raw）
    expect(fs.writeAtomicSync).not.toHaveBeenCalled();
    expect(fs.readSync(__test_DEEP_DREAM_STATE_FILE)).toBe(raw);
    const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toEqual(expect.arrayContaining([
      expect.stringMatching(/^cause=malformed$/),
      expect.stringMatching(/^quarantine=failed:EROFS/),
    ]));
  });

  it('unavailable（EACCES）→ degraded，不 quarantine、不写文件', async () => {
    const fs = {
      readSync: vi.fn(() => { throw new Error('EACCES: permission denied'); }),
      existsSync: vi.fn(() => false),
      moveSync: vi.fn(),
      writeAtomicSync: vi.fn(() => {}),
    } as unknown as FileSystem;
    const audit = makeMockAudit();

    const { degraded } = __test_loadRandomDreamState(fs, audit);

    expect(degraded).toEqual({ cause: 'unavailable', error: 'EACCES: permission denied' });
    expect(fs.moveSync).not.toHaveBeenCalled();
    expect(fs.writeAtomicSync).not.toHaveBeenCalled();
    const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(MEMORY_AUDIT_EVENTS.RANDOM_DREAM_ERROR);
    expect(call).toEqual(expect.arrayContaining([
      expect.stringMatching(/^site=load_state$/),
      expect.stringMatching(/^cause=unavailable$/),
      expect.stringContaining('EACCES'),
    ]));
  });

  it('run 级 gate：random-dream pulse 见 degraded 即 blocked 返回，不 schedule、不 save', async () => {
    const schedule = vi.fn();
    const fs = {
      readSync: vi.fn(() => '{ corrupt'),
      existsSync: vi.fn(() => false),
      moveSync: vi.fn(),
      writeAtomicSync: vi.fn(() => {}),
    } as unknown as FileSystem;
    const audit = makeMockAudit();

    const opts = {
      fs,
      motionFs: fs,
      audit,
      taskSystem: { schedule },
    } as unknown as RandomDreamOptions;
    await runRandomDream(opts);

    expect(schedule).not.toHaveBeenCalled();
    expect(fs.writeAtomicSync).not.toHaveBeenCalled();
    const calls = (audit.write as ReturnType<typeof vi.fn>).mock.calls;
    const jobCall = calls.find(c => c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_JOB);
    expect(jobCall).toEqual(expect.arrayContaining([
      expect.stringMatching(/^step=blocked$/),
      expect.stringMatching(/^reason=state_malformed$/),
    ]));
  });
});
