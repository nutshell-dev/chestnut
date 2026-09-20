/**
 * @module L6.Watchdog.Spawn
 * Watchdog daemon spawn 原语：spawnDetached + poll 等待 active owner 出现。
 *
 * 不含 CLI 关注点（console.log / CliError / audit）。CLI 外壳在 cli/commands/watchdog-cli.ts。
 */
import { setTimeout } from 'timers/promises';
import { spawnDetached } from '../foundation/process-exec/index.js';
import { getWorkspaceRoot } from '../foundation/claw-identity/index.js';
import { getWatchdogEntryPath } from './watchdog-context.js';
import { isWatchdogAlive, getWatchdogPid } from './watchdog-pid.js';
import { WATCHDOG_LOG_HINT } from './watchdog-log.js';
import type { FileSystem } from '../foundation/fs/index.js';

/**
 * spawn 后 poll alive 的间隔（ms）。
 * Derivation: 100ms — 1:1 保原 watchdog-cli.ts WATCHDOG_POLL_INTERVAL_MS。
 */
const WATCHDOG_POLL_INTERVAL_MS = 100;

/**
 * poll alive 最大次数。
 * Derivation: 100ms × 30 = 3s — 1:1 保原 watchdog-cli.ts WATCHDOG_START_MAX_ATTEMPTS。
 */
const WATCHDOG_START_MAX_ATTEMPTS = 30;

/**
 * Spawn watchdog daemon candidate 并 poll 等待 active owner 出现。
 *
 * 不保证返回的 pid 是自己的 child（per-contender 语义下并发 caller 可能 spawn
 * 多个 candidate，只有一个 commit directory ownership 胜出）。
 *
 * @returns 当前 active owner 的 pid
 * @throws Error 如果 spawn 后超时仍无 alive watchdog
 */
export async function spawnWatchdogCandidate(
  fsFactory: (baseDir: string) => FileSystem,
): Promise<number> {
  const watchdogEntryPath = getWatchdogEntryPath();
  const chestnutRoot = getWorkspaceRoot();
  // phase 1763: 提交点前失败经 typed outcome 抛出（含原始 errno/时间/命令身份），
  // 不再静默落到 poll 超时；提交点后异步失败经 stderr sink 保持可观察。
  const outcome = await spawnDetached('node', [watchdogEntryPath], {
    env: { ...process.env, CHESTNUT_ROOT: chestnutRoot },
    cwd: chestnutRoot,
    onSpawnFailure: (failure) => {
      console.error(
        `[watchdog] post-commit spawn failure: command=${failure.command}` +
          ` pid=${failure.pid ?? 'unknown'} errno=${failure.errno ?? failure.code ?? 'unknown'}` +
          ` at=${failure.atMs}: ${failure.message}`,
      );
    },
  });
  if (outcome.kind === 'failed') {
    const f = outcome.failure;
    throw new Error(
      `Watchdog spawn pre-commit failure (command="${f.command}"` +
        ` errno=${f.errno ?? f.code ?? 'unknown'} at=${f.atMs}): ${f.message}`,
    );
  }

  let attempts = 0;
  while (!isWatchdogAlive(fsFactory) && attempts < WATCHDOG_START_MAX_ATTEMPTS) {
    await setTimeout(WATCHDOG_POLL_INTERVAL_MS);
    attempts++;
  }

  const pid = getWatchdogPid(fsFactory);
  if (!pid) {
    throw new Error(
      `Watchdog failed to start within ${(WATCHDOG_POLL_INTERVAL_MS * WATCHDOG_START_MAX_ATTEMPTS) / 1000}s. ` +
      // Phase 1878 Step K: 指向 Watchdog owner 日志面（watchdog-log 单源提示）；
      // 旧文案指的 .chestnut/logs/ 已退役（legacy-retirement 登记）。
      `Check watchdog log at ${WATCHDOG_LOG_HINT}.`,
    );
  }
  return pid;
}
