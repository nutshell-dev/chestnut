import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileEntry } from '../../../src/foundation/fs/types.js';
import {
  tryAcquireClaim,
  releaseClaim,
  tryAcquireClaimSync,
  releaseClaimSync,
  type LockClaimContext,
} from '../../../src/foundation/fs/lock-protocol.js';
import { LOCK_AUDIT_EVENTS } from '../../../src/foundation/fs/lock-audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ProcessStartTime } from '../../../src/foundation/process-exec/index.js';

interface MockAudit {
  events: Array<{ type: string; cols: (string | number)[] }>;
}

function makeMockAudit(): MockAudit & AuditLog {
  const audit: MockAudit = { events: [] };
  return {
    __brand: 'AuditLog',
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
    write: (type: string, ...cols: (string | number)[]) => {
      audit.events.push({ type, cols });
    },
    ...audit,
  } as unknown as MockAudit & AuditLog;
}

function makeCtx(tempDir: string, overrides?: Partial<LockClaimContext>): LockClaimContext {
  return {
    fs: new NodeFileSystem({ baseDir: tempDir }),
    ...overrides,
  };
}

/** 构造一个非当前进程的 pid，用于模拟其他 contender。 */
function otherPid(): number {
  return process.pid + 1;
}

function fileEntry(name: string, dir: string): FileEntry {
  return {
    name,
    path: path.join(dir, name),
    isDirectory: false,
    isFile: true,
    size: 0,
    mtime: new Date(),
  };
}

describe('lock-protocol', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1047-')); });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  it('单 contender 正常 acquire/release', async () => {
    const ctx = makeCtx(tempDir);
    const token = await tryAcquireClaim(ctx, 'lock');
    expect(token).not.toBeNull();

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    expect(fs.readdirSync(claimsDir)).toHaveLength(1);

    await releaseClaim(ctx, 'lock', token!);
    expect(fs.readdirSync(claimsDir)).toHaveLength(0);
  });

  it('选举：当前 contender 输给更早 timestamp 的其他 claim', async () => {
    const audit = makeMockAudit();
    const isAlive = (_pid: number, _startTime?: ProcessStartTime): boolean => true;
    const ctx = makeCtx(tempDir, { audit, isAlive });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const earlierToken = 'earlier-token';
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.${otherPid()}.${earlierToken}`),
      JSON.stringify({ pid: otherPid(), timestamp: Date.now() - 1000, ownerToken: earlierToken, startTime: '0' }),
      { flag: 'wx' },
    );

    const result = await tryAcquireClaim(ctx, 'lock');

    expect(result).toBeNull();
    expect(fs.readdirSync(claimsDir).some(n => n.endsWith(earlierToken))).toBe(true);
    expect(audit.events.some(e => e.type === LOCK_AUDIT_EVENTS.CLAIM_ELECTION_LOST)).toBe(true);
  });

  it('选举：当前 contender 赢得比它更晚的其他 claim', async () => {
    const isAlive = (_pid: number, _startTime?: ProcessStartTime): boolean => true;
    const ctx = makeCtx(tempDir, { isAlive });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const laterToken = 'later-token';
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() + 86400000}.${otherPid()}.${laterToken}`),
      JSON.stringify({ pid: otherPid(), timestamp: Date.now() + 86400000, ownerToken: laterToken, startTime: '0' }),
      { flag: 'wx' },
    );

    const result = await tryAcquireClaim(ctx, 'lock');

    expect(result).not.toBeNull();
    expect(fs.readdirSync(claimsDir).some(n => n.endsWith(laterToken))).toBe(true);
    expect(fs.readdirSync(claimsDir).some(n => n.endsWith(result!))).toBe(true);
    expect(fs.readdirSync(claimsDir)).toHaveLength(2);
  });

  it('选举：timestamp 相同则 ownerToken 字典序小者获胜', async () => {
    vi.useFakeTimers({ now: 1234567890123 });
    const isAlive = (_pid: number, _startTime?: ProcessStartTime): boolean => true;
    const ctx = makeCtx(tempDir, { isAlive });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    // newShortUuid 生成 8 位小写 hex；'00000000' 字典序小于任何非全零 hex。
    const smallerToken = '00000000';
    fs.writeFileSync(
      path.join(claimsDir, `claim.1234567890123.${otherPid()}.${smallerToken}`),
      JSON.stringify({ pid: otherPid(), timestamp: 1234567890123, ownerToken: smallerToken, startTime: '0' }),
      { flag: 'wx' },
    );

    const result = await tryAcquireClaim(ctx, 'lock');

    vi.useRealTimers();

    expect(result).toBeNull();
    expect(fs.readdirSync(claimsDir).some(n => n.endsWith(smallerToken))).toBe(true);
  });

  it('stale recovery 清理已死 PID', async () => {
    const audit = makeMockAudit();
    const ctx = makeCtx(tempDir, { audit });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const deadPid = 99999999;
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now()}.${deadPid}.dead-token`),
      JSON.stringify({ pid: deadPid, timestamp: Date.now(), ownerToken: 'dead-token', startTime: '0' }),
      { flag: 'wx' },
    );

    const token = await tryAcquireClaim(ctx, 'lock');
    expect(token).not.toBeNull();

    const files = fs.readdirSync(claimsDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(token!)).toBe(true);

    expect(audit.events.some(e => e.type === LOCK_AUDIT_EVENTS.CLAIM_STALE_RECOVERED)).toBe(true);
  });

  it('release 只删除自己文件，不误删其他 contender', async () => {
    const ctx = makeCtx(tempDir);

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const ownToken = 'own-token';
    const otherToken = 'other-token';
    const now = Date.now();
    fs.writeFileSync(
      path.join(claimsDir, `claim.${now}.${process.pid}.${ownToken}`),
      JSON.stringify({ pid: process.pid, timestamp: now, ownerToken: ownToken, startTime: '0' }),
      { flag: 'wx' },
    );
    fs.writeFileSync(
      path.join(claimsDir, `claim.${now}.${otherPid()}.${otherToken}`),
      JSON.stringify({ pid: otherPid(), timestamp: now, ownerToken: otherToken, startTime: '0' }),
      { flag: 'wx' },
    );

    await releaseClaim(ctx, 'lock', ownToken);
    const files = fs.readdirSync(claimsDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(otherToken)).toBe(true);
  });

  it('自定义 isAlive 参与判活：startTime 不匹配视为死亡', async () => {
    const audit = makeMockAudit();
    const pid = otherPid();
    const isAlive = (checkedPid: number, startTime?: ProcessStartTime): boolean => {
      if (checkedPid === process.pid) return true;
      return checkedPid === pid && startTime === 'expected-start-time';
    };
    const ctx = makeCtx(tempDir, { audit, isAlive });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now()}.${pid}.wrong-start-token`),
      JSON.stringify({ pid, timestamp: Date.now(), ownerToken: 'wrong-start-token', startTime: 'wrong-start-time' }),
      { flag: 'wx' },
    );

    const token = await tryAcquireClaim(ctx, 'lock');
    expect(token).not.toBeNull();

    const files = fs.readdirSync(claimsDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(token!)).toBe(true);
  });

  it('lockDir/claims 不存在时 acquire 仍可创建', async () => {
    const ctx = makeCtx(tempDir);
    const token = await tryAcquireClaim(ctx, 'fresh-lock');
    expect(token).not.toBeNull();
    expect(fs.existsSync(path.join(tempDir, 'fresh-lock', 'claims'))).toBe(true);
  });

  it('release 在 claims 目录不存在时为 no-op', async () => {
    const ctx = makeCtx(tempDir);
    await expect(releaseClaim(ctx, 'missing-lock', 'any-token')).resolves.toBeUndefined();
  });

  it('double-check: 第一次 list 后出现的更早 claim 应使当前 contender 落选', async () => {
    const ctx = makeCtx(tempDir);
    const claimsDir = path.join(tempDir, 'lock', 'claims');
    let listCall = 0;
    vi.spyOn(ctx.fs, 'list').mockImplementation(async (dir, _opts) => {
      listCall++;
      const names = fs.readdirSync(claimsDir);
      const base = names.map(n => fileEntry(n, dir));
      if (listCall === 1) {
        return base;
      }
      return [
        ...base,
        fileEntry(`claim.0.${otherPid()}.injected-earlier`, dir),
      ];
    });

    const result = await tryAcquireClaim(ctx, 'lock');

    expect(result).toBeNull();
    expect(fs.readdirSync(claimsDir)).toHaveLength(0);
  });

  it('同 PID 同 startTime 重入应落选（不会误删自己的旧 claim）', async () => {
    const ctx = makeCtx(tempDir);

    const token1 = await tryAcquireClaim(ctx, 'lock');
    expect(token1).not.toBeNull();

    const token2 = await tryAcquireClaim(ctx, 'lock');
    expect(token2).toBeNull();

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    const files = fs.readdirSync(claimsDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(token1!)).toBe(true);
  });

  it('同 PID 不同 startTime 视为 PID 复用旧残留并清理', async () => {
    const audit = makeMockAudit();
    const currentStartTime = 'current-start-time';
    const ctx = makeCtx(tempDir, {
      audit,
      getProcessStartTime: () => currentStartTime,
    });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const oldToken = 'old-token';
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.${process.pid}.${oldToken}`),
      JSON.stringify({ pid: process.pid, timestamp: Date.now() - 1000, ownerToken: oldToken, startTime: 'old-start-time' }),
      { flag: 'wx' },
    );

    const result = await tryAcquireClaim(ctx, 'lock');

    expect(result).not.toBeNull();
    const files = fs.readdirSync(claimsDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(result!)).toBe(true);
    expect(
      audit.events.some(
        e => e.type === LOCK_AUDIT_EVENTS.CLAIM_STALE_RECOVERED
          && e.cols.some(c => String(c).includes('pid_reused')),
      ),
    ).toBe(true);
  });

  it('其他 contender 的 corrupt claim 应 fail-closed 视为存活', async () => {
    const audit = makeMockAudit();
    const isAlive = (_pid: number, _startTime?: ProcessStartTime): boolean => true;
    const ctx = makeCtx(tempDir, { audit, isAlive });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const corruptToken = 'corrupt-token';
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.${otherPid()}.${corruptToken}`),
      'not-valid-json',
      { flag: 'wx' },
    );

    const result = await tryAcquireClaim(ctx, 'lock');

    expect(result).toBeNull();
    expect(fs.readdirSync(claimsDir).some(n => n.endsWith(corruptToken))).toBe(true);
    expect(audit.events.some(e => e.type === LOCK_AUDIT_EVENTS.CLAIM_CORRUPT)).toBe(true);
  });

  it('其他 contender 的 unreadable claim 应 fail-closed 视为存活', async () => {
    const audit = makeMockAudit();
    const ctx = makeCtx(tempDir, { audit });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const otherToken = 'unreadable-token';
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.${otherPid()}.${otherToken}`),
      JSON.stringify({ pid: otherPid(), timestamp: Date.now() - 1000, ownerToken: otherToken, startTime: '0' }),
      { flag: 'wx' },
    );

    vi.spyOn(ctx.fs, 'read').mockImplementation(async (filePath) => {
      if (filePath.endsWith(otherToken)) {
        throw new Error('simulated EACCES');
      }
      return '';
    });

    const result = await tryAcquireClaim(ctx, 'lock');

    expect(result).toBeNull();
    expect(fs.readdirSync(claimsDir).some(n => n.endsWith(otherToken))).toBe(true);
    expect(audit.events.some(e => e.type === LOCK_AUDIT_EVENTS.CLAIM_READ_FAILED)).toBe(true);
  });

  it('sync: 单 contender 正常 acquire/release', () => {
    const ctx = makeCtx(tempDir);
    const token = tryAcquireClaimSync(ctx, 'lock');
    expect(token).not.toBeNull();

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    expect(fs.readdirSync(claimsDir)).toHaveLength(1);

    releaseClaimSync(ctx, 'lock', token!);
    expect(fs.readdirSync(claimsDir)).toHaveLength(0);
  });

  it('sync: double-check 应拦截晚到的更早 claim', () => {
    const ctx = makeCtx(tempDir);
    const claimsDir = path.join(tempDir, 'lock', 'claims');
    let listCall = 0;
    vi.spyOn(ctx.fs, 'listSync').mockImplementation((dir, _opts) => {
      listCall++;
      const names = fs.readdirSync(claimsDir);
      const base = names.map(n => fileEntry(n, dir));
      if (listCall === 1) {
        return base;
      }
      return [
        ...base,
        fileEntry(`claim.0.${otherPid()}.injected-earlier`, dir),
      ];
    });

    const result = tryAcquireClaimSync(ctx, 'lock');

    expect(result).toBeNull();
    expect(fs.readdirSync(claimsDir)).toHaveLength(0);
  });

  it('sync: 同 PID 同 startTime 重入应落选', () => {
    const ctx = makeCtx(tempDir);

    const token1 = tryAcquireClaimSync(ctx, 'lock');
    expect(token1).not.toBeNull();

    const token2 = tryAcquireClaimSync(ctx, 'lock');
    expect(token2).toBeNull();

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    const files = fs.readdirSync(claimsDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(token1!)).toBe(true);
  });

  it('sync: 同 PID 不同 startTime 视为旧残留并清理', () => {
    const audit = makeMockAudit();
    const currentStartTime = 'current-start-time';
    const ctx = makeCtx(tempDir, {
      audit,
      getProcessStartTime: () => currentStartTime,
    });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const oldToken = 'old-token';
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.${process.pid}.${oldToken}`),
      JSON.stringify({ pid: process.pid, timestamp: Date.now() - 1000, ownerToken: oldToken, startTime: 'old-start-time' }),
      { flag: 'wx' },
    );

    const result = tryAcquireClaimSync(ctx, 'lock');

    expect(result).not.toBeNull();
    const files = fs.readdirSync(claimsDir);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(result!)).toBe(true);
    expect(
      audit.events.some(
        e => e.type === LOCK_AUDIT_EVENTS.CLAIM_STALE_RECOVERED
          && e.cols.some(c => String(c).includes('pid_reused')),
      ),
    ).toBe(true);
  });

  it('sync: 其他 contender 的 corrupt claim 应 fail-closed 视为存活', () => {
    const audit = makeMockAudit();
    const isAlive = (_pid: number, _startTime?: ProcessStartTime): boolean => true;
    const ctx = makeCtx(tempDir, { audit, isAlive });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const corruptToken = 'corrupt-token';
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.${otherPid()}.${corruptToken}`),
      'not-valid-json',
      { flag: 'wx' },
    );

    const result = tryAcquireClaimSync(ctx, 'lock');

    expect(result).toBeNull();
    expect(fs.readdirSync(claimsDir).some(n => n.endsWith(corruptToken))).toBe(true);
    expect(audit.events.some(e => e.type === LOCK_AUDIT_EVENTS.CLAIM_CORRUPT)).toBe(true);
  });

  it('sync: 其他 contender 的 unreadable claim 应 fail-closed 视为存活', () => {
    const audit = makeMockAudit();
    const ctx = makeCtx(tempDir, { audit });

    const claimsDir = path.join(tempDir, 'lock', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const otherToken = 'unreadable-token';
    fs.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.${otherPid()}.${otherToken}`),
      JSON.stringify({ pid: otherPid(), timestamp: Date.now() - 1000, ownerToken: otherToken, startTime: '0' }),
      { flag: 'wx' },
    );

    vi.spyOn(ctx.fs, 'readSync').mockImplementation((filePath) => {
      if (filePath.endsWith(otherToken)) {
        throw new Error('simulated EACCES');
      }
      return '';
    });

    const result = tryAcquireClaimSync(ctx, 'lock');

    expect(result).toBeNull();
    expect(fs.readdirSync(claimsDir).some(n => n.endsWith(otherToken))).toBe(true);
    expect(audit.events.some(e => e.type === LOCK_AUDIT_EVENTS.CLAIM_READ_FAILED)).toBe(true);
  });
});
