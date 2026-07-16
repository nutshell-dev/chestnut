/**
 * @module L1.FileSystem.LockProtocol
 *
 * Per-contender 文件锁协议核心原语。
 *
 * 三个锁系统（contract、watchdog、process-manager）共用同一协议：
 * 在 <lockDir>/claims/ 下创建 claim.<timestamp>.<pid>.<ownerToken> 文件，
 * 按 timestamp ASC + ownerToken ASC 选举 winner；持有 winner token 的调用方
 * 视为获得锁。协议不实现 retry loop，由各锁系统的 wrapper 负责。
 */

import { newShortUuid } from '../node-utils/index.js';
import { getProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import type { AuditLog } from '../audit/index.js';
import type { FileSystem } from './types.js';
import { isFileNotFound } from './types.js';
import { LOCK_AUDIT_EVENTS } from './lock-audit-events.js';

export interface LockClaimContext {
  fs: FileSystem;
  audit?: AuditLog;
  isAlive?: (pid: number, startTime?: ProcessStartTime) => boolean;
  /** 可选的进程启动时间探针；未提供时使用 process-exec 默认实现。 */
  getProcessStartTime?: (pid: number) => ProcessStartTime | undefined;
}

/**
 * 单次 acquire 尝试（不含 retry loop，由调用方封装）。
 *
 * 返回 ownerToken 表示当前进程当选 winner；返回 null 表示已有其他存活 contender
 * 持有更早或字典序更小的 claim。
 */
export async function tryAcquireClaim(
  ctx: LockClaimContext,
  lockDir: string,
): Promise<string | null> {
  const claimsDir = `${lockDir}/claims`;
  const ownerToken = newShortUuid();
  const pid = process.pid;
  const getStartTime = ctx.getProcessStartTime ?? getProcessStartTime;
  const startTime = getStartTime(pid) ?? '0';

  // 1. 确保 claims 目录存在
  await ctx.fs.ensureDir(claimsDir);

  // 2. 在紧邻 write 之前获取 timestamp，缩小竞态窗口（P0-1 timestamp race）
  const timestamp = Date.now();

  // 3. 原子创建自己的 claim 文件（O_EXCL）
  const claimName = `claim.${timestamp}.${pid}.${ownerToken}`;
  const claimPath = `${claimsDir}/${claimName}`;
  const claimContent = JSON.stringify({ pid, timestamp, ownerToken, startTime });
  try {
    ctx.fs.writeExclusiveSync(claimPath, claimContent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // 极低概率碰撞：同 pid 同 ms 同 token → 重新生成后重试一次
      return tryAcquireClaim(ctx, lockDir);
    }
    throw err;
  }

  // 4. 列出所有 claim 文件
  let entries: { name: string }[];
  try {
    entries = await ctx.fs.list(claimsDir, { includeDirs: false });
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }

  // 5. Stale recovery + 收集有效 claim（fail-closed：无法判死的 claim 视为存活）
  const aliveClaims: string[] = [];
  for (const entry of entries) {
    // 从文件名提取 pid（无需读内容）
    const parts = entry.name.split('.');
    if (parts.length < 4 || parts[0] !== 'claim') continue; // 跳过非 claim 文件
    const filePid = parseInt(parts[2], 10);
    if (Number.isNaN(filePid)) continue;

    // 同 PID 的 claim：需用 startTime 区分同进程实例重入与 PID 复用残留
    if (filePid === pid && !entry.name.endsWith(ownerToken)) {
      let fileStartTime: string | undefined;
      try {
        const fc = JSON.parse(await ctx.fs.read(`${claimsDir}/${entry.name}`));
        fileStartTime = fc.startTime;
      } catch { /* 读失败/JSON 损坏 → 无法判定，走 fail-closed 路径 */ }

      if (fileStartTime !== undefined && fileStartTime !== startTime) {
        // 不同进程实例（PID 复用）→ 旧残留，可安全删除
        try { await ctx.fs.delete(`${claimsDir}/${entry.name}`); } catch { /* silent: 并发竞争 */ }
        ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_STALE_RECOVERED, `claim=${entry.name} reason=pid_reused`);
        continue;
      }

      // startTime 相同或无法获取 → 同进程重入或无法判定，不删，参与选举
      if (fileStartTime === undefined) {
        ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_CORRUPT, `claim=${entry.name}`);
      }
      aliveClaims.push(entry.name);
      continue;
    }

    // 其他进程 → 判活（read/parse 失败时 fail-closed，视为存活并 audit）
    let parsed: { pid: number; startTime?: string };
    try {
      const fileContent = await ctx.fs.read(`${claimsDir}/${entry.name}`);
      try {
        parsed = JSON.parse(fileContent);
      } catch {
        ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_CORRUPT, `claim=${entry.name}`);
        aliveClaims.push(entry.name); // fail-closed: 损坏 claim 视为存活
        continue;
      }
    } catch (readErr) {
      ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_READ_FAILED, `claim=${entry.name} reason=${String(readErr)}`);
      aliveClaims.push(entry.name); // fail-closed: 不可读 claim 视为存活
      continue;
    }

    const isAliveFn = ctx.isAlive ?? defaultIsAlive;
    if (!isAliveFn(parsed.pid, parsed.startTime as ProcessStartTime | undefined)) {
      // 持有者已死 → 安全删除
      try { await ctx.fs.delete(`${claimsDir}/${entry.name}`); } catch { /* silent: stale recovery 并发竞争，文件可能已被其他 contender 删除 */ }
      ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_STALE_RECOVERED, `claim=${entry.name}`);
      continue;
    }

    aliveClaims.push(entry.name);
  }

  // 6. 如果没有存活的 claim（全被 stale recovery 清了），当前就是 winner
  if (aliveClaims.length === 0) return ownerToken;

  // 7. 选举：按 timestamp ASC → ownerToken ASC
  aliveClaims.sort(compareClaimNames);

  // 8. 判断自己是否是 winner，并在 return 前 double-check 防晚到早 timestamp 的 contender
  const winner = aliveClaims[0];
  if (winner.endsWith(ownerToken)) {
    const recheck = await ctx.fs.list(claimsDir, { includeDirs: false });
    const recheckNames = recheck.map(e => e.name).filter(n => n.startsWith('claim.'));
    if (recheckNames.some(n => compareClaimNames(n, claimName) < 0)) {
      // 出现了更早的 claim → 重选举，删除自己并返回 null
      try { await ctx.fs.delete(claimPath); } catch { /* silent: 自删 best-effort */ }
      return null;
    }
    return ownerToken;
  }

  // 9. 不是 winner → 删除自己的 claim
  try { await ctx.fs.delete(claimPath); } catch { /* silent: 落选者自删 best-effort，残留由后续 stale recovery 处理 */ }
  ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_ELECTION_LOST, `winner=${winner} own=${claimName}`);
  return null;
}

/**
 * 释放自己持有的 claim。
 *
 * 只删除文件名以 ownerToken 结尾的 claim；若已被 stale recovery 清理则为 no-op。
 */
export async function releaseClaim(
  ctx: LockClaimContext,
  lockDir: string,
  ownerToken: string,
): Promise<void> {
  const claimsDir = `${lockDir}/claims`;
  let entries: { name: string }[];
  try {
    entries = await ctx.fs.list(claimsDir, { includeDirs: false });
  } catch (err) {
    if (isFileNotFound(err)) return;
    throw err;
  }

  for (const entry of entries) {
    if (entry.name.endsWith(ownerToken)) {
      try { await ctx.fs.delete(`${claimsDir}/${entry.name}`); } catch { /* silent: release 自删 best-effort，已被清理则 no-op */ }
      return;
    }
  }
  // 找不到 → 已被 stale recovery 清理 → no-op
}

/**
 * 同步单次 acquire 尝试（process-manager spawn 路径需要同步原语）。
 *
 * 语义与 tryAcquireClaim 完全一致，仅使用 FileSystem 同步方法。
 */
export function tryAcquireClaimSync(
  ctx: LockClaimContext,
  lockDir: string,
): string | null {
  const claimsDir = `${lockDir}/claims`;
  const ownerToken = newShortUuid();
  const pid = process.pid;
  const getStartTime = ctx.getProcessStartTime ?? getProcessStartTime;
  const startTime = getStartTime(pid) ?? '0';

  ctx.fs.ensureDirSync(claimsDir);

  // timestamp 在 ensureDir 之后、write 之前获取，缩小竞态窗口
  const timestamp = Date.now();

  const claimName = `claim.${timestamp}.${pid}.${ownerToken}`;
  const claimPath = `${claimsDir}/${claimName}`;
  const claimContent = JSON.stringify({ pid, timestamp, ownerToken, startTime });
  try {
    ctx.fs.writeExclusiveSync(claimPath, claimContent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return tryAcquireClaimSync(ctx, lockDir);
    }
    throw err;
  }

  let entries: { name: string }[];
  try {
    entries = ctx.fs.listSync(claimsDir, { includeDirs: false });
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }

  const aliveClaims: string[] = [];
  for (const entry of entries) {
    const parts = entry.name.split('.');
    if (parts.length < 4 || parts[0] !== 'claim') continue;
    const filePid = parseInt(parts[2], 10);
    if (Number.isNaN(filePid)) continue;

    if (filePid === pid && !entry.name.endsWith(ownerToken)) {
      let fileStartTime: string | undefined;
      try {
        const fc = JSON.parse(ctx.fs.readSync(`${claimsDir}/${entry.name}`));
        fileStartTime = fc.startTime;
      } catch { /* 读失败/JSON 损坏 → 无法判定，走 fail-closed 路径 */ }

      if (fileStartTime !== undefined && fileStartTime !== startTime) {
        try { ctx.fs.deleteSync(`${claimsDir}/${entry.name}`); } catch { /* silent */ }
        ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_STALE_RECOVERED, `claim=${entry.name} reason=pid_reused`);
        continue;
      }

      if (fileStartTime === undefined) {
        ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_CORRUPT, `claim=${entry.name}`);
      }
      aliveClaims.push(entry.name);
      continue;
    }

    let parsed: { pid: number; startTime?: string };
    try {
      const fileContent = ctx.fs.readSync(`${claimsDir}/${entry.name}`);
      try {
        parsed = JSON.parse(fileContent);
      } catch {
        ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_CORRUPT, `claim=${entry.name}`);
        aliveClaims.push(entry.name);
        continue;
      }
    } catch (readErr) {
      ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_READ_FAILED, `claim=${entry.name} reason=${String(readErr)}`);
      aliveClaims.push(entry.name);
      continue;
    }

    const isAliveFn = ctx.isAlive ?? defaultIsAlive;
    if (!isAliveFn(parsed.pid, parsed.startTime as ProcessStartTime | undefined)) {
      try { ctx.fs.deleteSync(`${claimsDir}/${entry.name}`); } catch { /* silent */ }
      ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_STALE_RECOVERED, `claim=${entry.name}`);
      continue;
    }

    aliveClaims.push(entry.name);
  }

  if (aliveClaims.length === 0) return ownerToken;

  aliveClaims.sort(compareClaimNames);

  const winner = aliveClaims[0];
  if (winner.endsWith(ownerToken)) {
    const recheck = ctx.fs.listSync(claimsDir, { includeDirs: false });
    const recheckNames = recheck.map(e => e.name).filter(n => n.startsWith('claim.'));
    if (recheckNames.some(n => compareClaimNames(n, claimName) < 0)) {
      try { ctx.fs.deleteSync(claimPath); } catch { /* silent */ }
      return null;
    }
    return ownerToken;
  }

  try { ctx.fs.deleteSync(claimPath); } catch { /* silent */ }
  ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_ELECTION_LOST, `winner=${winner} own=${claimName}`);
  return null;
}

/**
 * 同步释放自己持有的 claim。
 *
 * 语义与 releaseClaim 一致，仅使用 FileSystem 同步方法。
 */
export function releaseClaimSync(
  ctx: LockClaimContext,
  lockDir: string,
  ownerToken: string,
): void {
  const claimsDir = `${lockDir}/claims`;
  let entries: { name: string }[];
  try {
    entries = ctx.fs.listSync(claimsDir, { includeDirs: false });
  } catch (err) {
    if (isFileNotFound(err)) return;
    throw err;
  }

  for (const entry of entries) {
    if (entry.name.endsWith(ownerToken)) {
      try { ctx.fs.deleteSync(`${claimsDir}/${entry.name}`); } catch { /* silent */ }
      return;
    }
  }
}

function compareClaimNames(a: string, b: string): number {
  const ta = parseInt(a.split('.')[1], 10);
  const tb = parseInt(b.split('.')[1], 10);
  if (ta !== tb) return ta - tb;
  const tokenA = a.split('.').slice(3).join('.');
  const tokenB = b.split('.').slice(3).join('.');
  return tokenA < tokenB ? -1 : tokenA > tokenB ? 1 : 0;
}

function defaultIsAlive(pid: number, _startTime?: ProcessStartTime): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
