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
  const timestamp = Date.now();
  const pid = process.pid;
  const startTime = getProcessStartTime(pid) ?? '0';

  // 1. 确保 claims 目录存在
  await ctx.fs.ensureDir(claimsDir);

  // 2. 原子创建自己的 claim 文件（O_EXCL）
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

  // 3. 列出所有 claim 文件
  let entries: { name: string }[];
  try {
    entries = await ctx.fs.list(claimsDir, { includeDirs: false });
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }

  // 4. Stale recovery + 收集有效 claim
  const aliveClaims: string[] = [];
  for (const entry of entries) {
    // 从文件名提取 pid（无需读内容）
    const parts = entry.name.split('.');
    if (parts.length < 4 || parts[0] !== 'claim') continue; // 跳过非 claim 文件
    const filePid = parseInt(parts[2], 10);
    if (Number.isNaN(filePid)) continue;

    // 自己的旧残留 → 直接删
    if (filePid === pid && !entry.name.endsWith(ownerToken)) {
      try { await ctx.fs.delete(`${claimsDir}/${entry.name}`); } catch { /* silent: 自残留清理 best-effort，失败时留到下一轮 stale recovery 处理 */ }
      continue;
    }

    // 其他进程 → 判活
    let fileContent: string;
    try {
      fileContent = await ctx.fs.read(`${claimsDir}/${entry.name}`);
    } catch { continue; } // silent: 并发 unlink/read race，跳过该文件

    let parsed: { pid: number; startTime?: string };
    try { parsed = JSON.parse(fileContent); } catch { continue; } // silent: 损坏 claim 文件，跳过

    const isAliveFn = ctx.isAlive ?? defaultIsAlive;
    if (!isAliveFn(parsed.pid, parsed.startTime as ProcessStartTime | undefined)) {
      // 持有者已死 → 安全删除
      try { await ctx.fs.delete(`${claimsDir}/${entry.name}`); } catch { /* silent: stale recovery 并发竞争，文件可能已被其他 contender 删除 */ }
      ctx.audit?.write(LOCK_AUDIT_EVENTS.CLAIM_STALE_RECOVERED, `claim=${entry.name}`);
      continue;
    }

    aliveClaims.push(entry.name);
  }

  // 5. 如果没有存活的 claim（全被 stale recovery 清了），当前就是 winner
  if (aliveClaims.length === 0) return ownerToken;

  // 6. 选举：按 timestamp ASC → ownerToken ASC
  aliveClaims.sort(compareClaimNames);

  // 7. 判断自己是否是 winner
  const winner = aliveClaims[0];
  if (winner.endsWith(ownerToken)) return ownerToken;

  // 8. 不是 winner → 删除自己的 claim
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
