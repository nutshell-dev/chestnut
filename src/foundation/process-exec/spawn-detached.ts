import { spawn, type ChildProcess } from 'child_process';
import { openSync, closeSync } from 'fs';
import type {
  SpawnDetachedOptions,
  SpawnDetachedOutcome,
  SpawnDetachedFailure,
} from './types.js';
import { scrubEnv } from './env-scrub.js';
import { formatErr } from '../node-utils/index.js';

/**
 * 把任意 spawn 错误（同步 throw 或异步 'error' 事件负载）折叠为 typed failure，
 * 原始 errno/code/时间/命令身份无损保留。
 */
function toSpawnFailure(
  command: string,
  args: ReadonlyArray<string>,
  err: unknown,
  pid?: number,
): SpawnDetachedFailure {
  const e = err as NodeJS.ErrnoException;
  return {
    command,
    args,
    ...(pid !== undefined ? { pid } : {}),
    ...(e.errno !== undefined ? { errno: e.errno } : {}),
    ...(e.code !== undefined ? { code: e.code } : {}),
    message: formatErr(err),
    atMs: Date.now(),
  };
}

/**
 * phase 1763 (Phase 1762 冻结设计): 提交点 = child 'spawn' 事件成功交付且
 * pid 已存在。提交点前异步错误（ENOENT/EACCES 等）由本等待交付进
 * SpawnDetachedOutcome.failed；不得以 pid 非空替代提交点。
 */
function awaitCommitPoint(
  proc: ChildProcess,
  command: string,
  args: ReadonlyArray<string>,
): Promise<SpawnDetachedOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: SpawnDetachedOutcome): void => {
      if (settled) return;
      settled = true;
      proc.off('spawn', onSpawn);
      proc.off('error', onError);
      resolve(outcome);
    };
    const onSpawn = (): void => {
      if (proc.pid === undefined) {
        finish({
          kind: 'failed',
          failure: toSpawnFailure(command, args, new Error('spawn event without pid')),
        });
        return;
      }
      finish({ kind: 'spawned', pid: proc.pid });
    };
    const onError = (err: unknown): void => {
      finish({ kind: 'failed', failure: toSpawnFailure(command, args, err) });
    };
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
  });
}

/**
 * Spawn a long-running detached process (typically daemon).
 *
 * Encapsulates child_process.spawn + log fd management.
 * - detached: true / unref: true (daemon 独立 parent 生命周期)
 * - logFile: 内部 openSync 拿 fd / spawn 后 closeSync (child 已 inherit fd)
 *
 * phase 1763: 返回 typed SpawnDetachedOutcome。
 * - 提交点（child 'spawn' 事件）前同步/异步失败 → { kind: 'failed' }，
 *   调用方禁止把 pid 当作启动交付。
 * - 提交点后异步错误 → 注入的 onSpawnFailure sink（pid/command/errno/时间）；
 *   sink 未注入时默认 console.error；sink 自身抛错 fallback 到 stderr，
 *   任何失败都不再由空 listener 吞掉。
 * ChildProcess 句柄仍由本层封装，不跨边界暴露。
 */
export async function spawnDetached(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnDetachedOptions,
): Promise<SpawnDetachedOutcome> {
  let logFd: number | 'ignore' = 'ignore';
  try {
    logFd = options.logFile ? openSync(options.logFile, 'a') : 'ignore';
  } catch (err) {
    // silent: 同步 pre-commit 失败（如 logFile 父目录 ENOENT）已折叠进 typed failed outcome（原始 errno/时间无损），非吞错
    return { kind: 'failed', failure: toSpawnFailure(command, args, err) };
  }
  try {
    // phase 346 B1 (review-2026-06-13): 始终 scrub env 到 allowlist，
    // 避免 wholesale inherit parent's process.env 把 ssh-agent socket /
    // 任意 user-set 环境变量 / 别的 secret 灌入 detached 子进程。
    // caller 显式 options.env 仍走 scrub（caller 多半 spread process.env、
    // 真正想加的几 key 落 allowlist 内、scrub 不掉）。
    const rawEnv = options.env ?? process.env;
    const scrubbedEnv = scrubEnv(rawEnv as NodeJS.ProcessEnv);
    let proc: ChildProcess;
    try {
      proc = spawn(command, [...args], {
        cwd: options.cwd,
        env: scrubbedEnv,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
    } catch (err) {
      // spawn() 自身同步 throw（参数非法等）→ typed outcome
      return { kind: 'failed', failure: toSpawnFailure(command, args, err) };
    }

    const outcome = await awaitCommitPoint(proc, command, args);
    if (outcome.kind === 'failed') {
      return outcome;
    }

    // 提交点后：异步错误进 owner 可观察 sink（替代 phase 523 空 listener）。
    proc.on('error', (err) => {
      const failure = toSpawnFailure(command, args, err, proc.pid);
      try {
        if (options.onSpawnFailure) {
          options.onSpawnFailure(failure);
        } else {
          console.error( // console: L1 无 audit 依赖；未注入 sink 时 stderr 是最小可观察通道（非吞错）
            `[spawn-detached] post-commit spawn failure: command=${failure.command}` +
              ` pid=${failure.pid ?? 'unknown'} errno=${failure.errno ?? failure.code ?? 'unknown'}` +
              ` at=${failure.atMs}: ${failure.message}`,
          );
        }
      } catch (sinkErr) {
        // sink 失败本身不得静默：fallback stderr 保持可观察
        console.error( // console: L1 无 audit 依赖；sink 失败的 fallback 可观察通道
          `[spawn-detached] failure sink threw: ${String(sinkErr)};` +
            ` original failure: ${JSON.stringify(failure)}`,
        );
      }
    });
    proc.unref();
    return outcome;
  } finally {
    if (typeof logFd === 'number') closeSync(logFd);
  }
}
