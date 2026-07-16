import { getLockFile, getSpawnLockFile } from './paths.js';
import type { DaemonDir } from './types.js';
import * as path from 'path';
import { formatErr } from "../node-utils/index.js";
import { isAlive as defaultL1IsAlive, getProcessStartTime as defaultGetProcessStartTime, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';
import { isFileNotFound } from '../fs/index.js';
import { tryAcquireClaimSync, releaseClaimSync, type LockClaimContext } from '../fs/lock-protocol.js';



function isValidPid(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export type LockReadResult =
  | { status: 'missing' }
  | { status: 'valid'; holder: { pid: number; startTime?: ProcessStartTime } }
  | { status: 'corrupt'; error: string }
  | { status: 'io_error'; error: string };

/**
 * 由旧格式单文件锁路径推导 per-contender 协议 lock 目录。
 * e.g. daemon.lock → daemon-lock；daemon.lock.spawn → daemon.lock.spawn-lock
 */
function getLockNs(lockFile: string): string {
  return `${lockFile}-lock`;
}

function makeClaimContext(ctx: ProcessManagerContext): LockClaimContext {
  return {
    fs: ctx.fs,
    audit: ctx.audit,
    isAlive: ctx.l1IsAlive ?? defaultL1IsAlive,
    getProcessStartTime: ctx.getProcessStartTime ?? defaultGetProcessStartTime,
  };
}

/**
 * 旧格式单文件锁兼容：启动时若发现 legacy lock 文件，按旧协议判活一次。
 * - 活持有者 → 抛 LockConflictError，保留旧锁文件（运行中旧 daemon 继续拥有它）。
 * - 死持有者 → 删除旧锁文件，后续走新协议 acquire。
 * - 损坏 / IO 错误 → fail-closed。
 */
function migrateLegacyProcessLock(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  lockFile: string,
): void {
  const legacyResult = readLegacyLockFile(ctx, daemonDir, lockFile);
  if (legacyResult.status === 'missing') return;
  if (legacyResult.status === 'io_error' || legacyResult.status === 'corrupt') {
    throw new LockConflictError(
      daemonDir,
      `Cannot migrate legacy lock: ${legacyResult.status === 'io_error' ? 'I/O error' : 'corrupt'} (${legacyResult.error})`,
    );
  }

  const holder = legacyResult.holder;
  const holderStartTime = holder.startTime ?? (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(holder.pid);
  if ((ctx.l1IsAlive ?? defaultL1IsAlive)(holder.pid, holderStartTime)) {
    throw new LockConflictError(
      daemonDir,
      `Another "${daemonDir}" daemon is running (PID: ${holder.pid})`,
    );
  }
  if (holderStartTime === undefined && process.platform === 'win32') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.STARTTIME_VERIFY_SKIPPED_WINDOWS,
      `daemon_dir=${daemonDir}`,
      `pid=${holder.pid}`,
    );
  }

  // stale holder：删除旧格式锁文件，让后续 tryAcquireClaimSync 创建 claims/。
  try {
    ctx.fs.deleteSync(lockFile);
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
      `daemon_dir=${daemonDir}`,
      `op=migrate_legacy`,
      `pid=${holder.pid}`,
      `reason=holder_dead`,
    );
  } catch (e) {
    if (!isFileNotFound(e)) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
        `daemon_dir=${daemonDir}`,
        `op=migrate_legacy`,
        `reason=${formatErr(e)}`,
      );
    }
  }
}

function readLegacyLockFile(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  lockFile: string,
): LockReadResult {
  try {
    const content = ctx.fs.readSync(lockFile).trim();
    if (content === '') {
      return { status: 'corrupt', error: 'empty lock file' };
    }
    // Try JSON first (same format as PID file)
    try {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        const pid = (parsed as { pid?: unknown }).pid;
        if (isValidPid(pid)) {
          return {
            status: 'valid',
            holder: {
              pid,
              startTime:
                typeof (parsed as { startTime?: unknown }).startTime === 'string'
                  ? makeProcessStartTime((parsed as { startTime: string }).startTime)
                  : undefined,
            },
          };
        }
      }
    } catch {
      /* silent: JSON parse fail, fall through to legacy int parse */
    }
    // Legacy raw int format (phase 1023 lock file format JSON migration、sibling to pid.ts:34 同 audit const 共用)
    const legacyPid = parseInt(content, 10);
    if (isValidPid(legacyPid)) {
      if (/^\d+$/.test(content.trim())) {
        ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT, `daemon_dir=${daemonDir}`, `pid=${legacyPid}`, `file=lock`);
        return { status: 'valid', holder: { pid: legacyPid, startTime: undefined } };
      }
      return { status: 'corrupt', error: 'legacy lock pid not strict integer' };
    }
    return { status: 'corrupt', error: `unparseable lock content: ${content.slice(0, 50)}` };
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'missing' };
    // phase 586: 加 path forensic col、延续 phase 580 PID_READ_FAILED 模式
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
      `daemon_dir=${daemonDir}`,
      `path=${lockFile}`,
      `reason=${formatErr(err)}`,
    );
    return { status: 'io_error', error: formatErr(err) };
  }
}

/**
 * 从 per-contender claims 目录读取当前 winner。
 * claims/ 不存在或为空时返回 missing；winner claim 损坏时按 corrupt 处理。
 */
function readClaimLockFile(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  lockNs: string,
): LockReadResult {
  const claimsDir = `${lockNs}/claims`;
  let entries: { name: string }[];
  try {
    entries = ctx.fs.listSync(claimsDir, { includeDirs: false });
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'missing' };
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
      `daemon_dir=${daemonDir}`,
      `path=${claimsDir}`,
      `reason=${formatErr(err)}`,
    );
    return { status: 'io_error', error: formatErr(err) };
  }

  const claimNames = entries
    .filter((e) => {
      const parts = e.name.split('.');
      return parts.length >= 4 && parts[0] === 'claim' && !Number.isNaN(parseInt(parts[2], 10));
    })
    .map((e) => e.name)
    .sort((a, b) => {
      const ta = parseInt(a.split('.')[1], 10);
      const tb = parseInt(b.split('.')[1], 10);
      if (ta !== tb) return ta - tb;
      const tokenA = a.split('.').slice(3).join('.');
      const tokenB = b.split('.').slice(3).join('.');
      return tokenA < tokenB ? -1 : tokenA > tokenB ? 1 : 0;
    });

  if (claimNames.length === 0) return { status: 'missing' };

  const winner = claimNames[0];
  try {
    const content = ctx.fs.readSync(`${claimsDir}/${winner}`).trim();
    if (content === '') return { status: 'corrupt', error: 'empty claim file' };
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      const pid = (parsed as { pid?: unknown }).pid;
      if (isValidPid(pid)) {
        return {
          status: 'valid',
          holder: {
            pid,
            startTime:
              typeof (parsed as { startTime?: unknown }).startTime === 'string'
                ? makeProcessStartTime((parsed as { startTime: string }).startTime)
                : undefined,
          },
        };
      }
    }
    return { status: 'corrupt', error: `unparseable claim content: ${content.slice(0, 50)}` };
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'missing' };
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
      `daemon_dir=${daemonDir}`,
      `path=${claimsDir}/${winner}`,
      `reason=${formatErr(err)}`,
    );
    return { status: 'io_error', error: formatErr(err) };
  }
}

function readLockFile(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  lockFile: string,
): LockReadResult {
  const lockNs = getLockNs(lockFile);

  // 新协议优先：claims/ 目录存在则读 winner claim。
  const claimResult = readClaimLockFile(ctx, daemonDir, lockNs);
  if (claimResult.status !== 'missing') return claimResult;

  // 回退旧格式单文件锁（兼容运行中旧 daemon 或未迁移残留）。
  return readLegacyLockFile(ctx, daemonDir, lockFile);
}

export function readLock(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): LockReadResult {
  return readLockFile(ctx, daemonDir, getLockFile(ctx, daemonDir));
}

export function readLockPid(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): { pid: number; startTime?: ProcessStartTime } | null {
  const result = readLock(ctx, daemonDir);
  if (result.status === 'valid') return result.holder;
  return null;
}

/**
 * 缓存本 context 在各锁 namespace 上获得的 ownerToken，用于保持 release* API 不变。
 * WeakMap 避免跨 context 污染；context 释放后 token 自动可回收。
 */
const ownerTokenCache = new WeakMap<ProcessManagerContext, Map<string, string>>();

function getTokenMap(ctx: ProcessManagerContext): Map<string, string> {
  let map = ownerTokenCache.get(ctx);
  if (!map) {
    map = new Map();
    ownerTokenCache.set(ctx, map);
  }
  return map;
}

function cacheOwnerToken(ctx: ProcessManagerContext, lockNs: string, token: string): void {
  getTokenMap(ctx).set(lockNs, token);
}

function takeOwnerToken(ctx: ProcessManagerContext, lockNs: string): string | undefined {
  const map = getTokenMap(ctx);
  const token = map.get(lockNs);
  if (token !== undefined) map.delete(lockNs);
  return token;
}

function acquireLockFile(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  lockFile: string,
  auditCols: string[],
): void {
  ctx.fs.ensureDirSync(path.dirname(lockFile));

  // 旧格式兼容：若存在 legacy lock 文件，按旧协议判活一次。
  if (ctx.fs.existsSync(lockFile)) {
    migrateLegacyProcessLock(ctx, daemonDir, lockFile);
  }

  const lockNs = getLockNs(lockFile);
  const ownerToken = tryAcquireClaimSync(makeClaimContext(ctx), lockNs);
  if (ownerToken === null) {
    throw new LockConflictError(daemonDir, 'Election lost');
  }
  cacheOwnerToken(ctx, lockNs, ownerToken);

  // phase 584: 加 context=fresh col、与旧实现 stale_retry 路径对齐
  ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_ACQUIRED, `daemon_dir=${daemonDir}`, `pid=${process.pid}`, `context=fresh`, ...auditCols);
}

export function acquireLock(ctx: ProcessManagerContext, daemonDir: DaemonDir): void {
  acquireLockFile(ctx, daemonDir, getLockFile(ctx, daemonDir), []);
}

// phase 1017: spawn-transition 专用锁（daemon.lock.spawn）。语义与生命周期锁一致
// （EEXIST 校验持有者、stale reclaim、io_error/corrupt fail-closed），仅锁文件与
// audit col (lock=spawn) 不同。覆盖 {pid:0} → {pid:real} 窗口，与子 daemon assemble
// 时 acquireLock（daemon.lock）互不干扰。
export function acquireSpawnLock(ctx: ProcessManagerContext, daemonDir: DaemonDir): void {
  acquireLockFile(ctx, daemonDir, getSpawnLockFile(ctx, daemonDir), ['lock=spawn']);
}

function releaseLockFile(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  lockFile: string,
  auditCols: string[],
): void {
  const lockNs = getLockNs(lockFile);
  const ownerToken = takeOwnerToken(ctx, lockNs);
  if (ownerToken === undefined) {
    // 无缓存 token：可能是直接对旧格式锁文件调用 release，按旧语义只删除持有者是本进程的文件。
    const legacyResult = readLegacyLockFile(ctx, daemonDir, lockFile);
    if (legacyResult.status !== 'valid' || legacyResult.holder.pid !== process.pid) {
      return;
    }
    try {
      ctx.fs.deleteSync(lockFile);
      ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_RELEASED, `daemon_dir=${daemonDir}`, `pid=${process.pid}`, `context=legacy_fallback`, ...auditCols);
    } catch (err) {
      if (!isFileNotFound(err)) {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
          `daemon_dir=${daemonDir}`,
          `op=release_legacy_fallback`,
          `reason=${formatErr(err)}`,
          ...auditCols,
        );
      }
    }
    return;
  }

  releaseClaimSync(makeClaimContext(ctx), lockNs, ownerToken);
  ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_RELEASED, `daemon_dir=${daemonDir}`, `pid=${process.pid}`, ...auditCols);
}

export function releaseLock(ctx: ProcessManagerContext, daemonDir: DaemonDir): void {
  releaseLockFile(ctx, daemonDir, getLockFile(ctx, daemonDir), []);
}

// phase 1017: releaseSpawnLock — 仅当 spawn 锁持有者是本进程时删除（防误删他人锁）
export function releaseSpawnLock(ctx: ProcessManagerContext, daemonDir: DaemonDir): void {
  releaseLockFile(ctx, daemonDir, getSpawnLockFile(ctx, daemonDir), ['lock=spawn']);
}
