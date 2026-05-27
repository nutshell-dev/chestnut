/**
 * Contract Lock 子模块测试
 *
 * Phase 576: lock JSON.parse defensive schema 校验
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, releaseLock } from '../../../src/core/contract/lock.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { DEAD_PID } from '../../helpers/dead-pid.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,
    LOCK_RETRY_DELAY_MS: 10,
  };
});

let tmpDir: string;
let nodeFs: NodeFileSystem;
let mockAudit: { write: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-lock-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  mockAudit = makeMockAudit();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('acquireLock', () => {
  it('lock 文件 schema 非法（pid 非 number）→ audit LOCK_SCHEMA_INVALID + 走 corrupt 路径重建（A.lock-schema-validation phase 576）', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // 预先写入 schema 非法的 lock 文件
    await fs.writeFile(absLockPath, JSON.stringify({ pid: 'abc', time: null }), 'utf-8');

    await acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath);

    // audit LOCK_SCHEMA_INVALID 被调用
    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_lock_schema_invalid',
      expect.stringMatching(/^path=/),
      expect.stringMatching(/^raw=/),
    );

    // 第二次 retry 成功写入，锁文件内容应为合法 schema
    const raw = await fs.readFile(absLockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(typeof parsed.pid).toBe('number');
    expect(typeof parsed.time).toBe('number');
  }, 2000);

  it('lock 文件 schema 合法（pid + time 皆 number）但 pid dead → 0 LOCK_SCHEMA_INVALID audit / 走 stale_pid 路径', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // 写入合法但 dead pid 的 lock 文件
    await fs.writeFile(absLockPath, JSON.stringify({ pid: DEAD_PID, time: Date.now() }), 'utf-8');

    await acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath);

    const schemaInvalidCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === 'contract_lock_schema_invalid'
    );
    expect(schemaInvalidCalls).toHaveLength(0);

    // 第二次 retry 成功写入
    const raw = await fs.readFile(absLockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);
  }, 2000);

  it('lock 文件 schema 合法且 alive → 0 LOCK_SCHEMA_INVALID audit + acquireLock 最终失败', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // 写入当前进程持有的合法 lock 文件
    await fs.writeFile(absLockPath, JSON.stringify({ pid: process.pid, time: Date.now() }), 'utf-8');

    await expect(
      acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath)
    ).rejects.toThrow(/Failed to acquire lock after/);

    const schemaInvalidCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === 'contract_lock_schema_invalid'
    );
    expect(schemaInvalidCalls).toHaveLength(0);
  }, 2000);

  it('lock 文件 schema 非法（time 为 NaN）→ audit LOCK_SCHEMA_INVALID', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    await fs.writeFile(absLockPath, JSON.stringify({ pid: FAKE_LIVE_PID, time: NaN }), 'utf-8');

    await acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath);

    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_lock_schema_invalid',
      expect.stringMatching(/^path=/),
      expect.stringMatching(/^raw=/),
    );
  }, 2000);
});

describe('releaseLock', () => {
  it('should delete lock file', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });
    await fs.writeFile(absLockPath, 'lock', 'utf-8');

    await releaseLock({ fs: nodeFs, audit: mockAudit as any }, lockPath);

    await expect(fs.access(absLockPath)).rejects.toThrow();
  });
});
