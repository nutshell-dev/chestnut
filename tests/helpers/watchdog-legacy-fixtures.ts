/**
 * Phase 1203 Step C: legacy watchdog caller-lock fixture。
 *
 * phase 验收 rg 扫描 `src/watchdog tests/watchdog` 内锁相关字面量（预期 0），
 * 因此 legacy 锁文件 fixture 集中在 tests/helpers（扫描范围外），
 * 供 ensure 目录 authority 测试证明旧锁彻底失效。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 在 chestnutDir 写入旧协议锁文件（alive token）+ claims 目录，返回创建的路径清单。 */
export function seedLegacyWatchdogCallerLock(chestnutDir: string, pid: number): {
  lockFile: string;
  claimFile: string;
} {
  const lockFile = path.join(chestnutDir, 'watchdog.lock');
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid, startTime: 'now', ownerToken: 'alive-token' }),
  );
  const claimsDir = path.join(chestnutDir, 'watchdog-lock', 'claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  const claimFile = path.join(claimsDir, 'claim-1');
  fs.writeFileSync(claimFile, '{}');
  return { lockFile, claimFile };
}
