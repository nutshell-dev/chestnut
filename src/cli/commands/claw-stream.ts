/**
 * @module L6.CLI.Claw.Stream
 * Tail a claw's stream.jsonl and emit chestnut.launcher.v1 envelopes to stdout.
 *
 * Long-running foreground process. External viewport clients (launcher /
 * scripts) consume this to render real-time motion / claw activity without
 * binding to TUI.
 *
 * phase 1990 Step B：stdout 为协议 stdout——内部 StreamEvent 经 LauncherEventMapper
 * 映射为 event envelope（稳定 payload，不泄漏内部 union）；正常终止写 terminal，
 * daemon 死亡/启动失败写 error 后非零退出。sequence 会话内严格连号。
 *
 * Emits stream-reader lifecycle/fault audit events via createStreamReader.
 */

import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';

import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import { assertPublishedClaw } from './claw-target.js';
import { CliError } from '../errors.js';
import { actionAuditFor } from '../action-scope.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';

import { createStreamReader, STREAM_FILE, findRecentTurnStartOffset, readCurrentTurnSnapshot } from '../../foundation/stream/index.js';
import type { StreamEvent } from '../../foundation/stream/index.js';
import {
  createLauncherSequencer,
  formatClawBarError,
  launcherActivityEnvelope,
  launcherErrorEnvelope,
  makeLauncherEnvelope,
  writeLauncherEnvelope,
} from '../../cli-protocol/index.js';
import { LauncherActivityMapper, LauncherEventMapper, makeLauncherSessionId } from '../launcher-envelope-producer.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { isAlive, isPidArgvMatching } from '../../foundation/process-exec/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

type StreamStartMode =
  | { kind: 'recent-turn' }
  | { kind: 'current-turn' }
  | { kind: 'now' }
  | { kind: 'history' }
  | { kind: 'offset'; value: number };

interface StreamOptions {
  startMode?: StreamStartMode;
}

/** Polling interval for daemon liveness check (ms). 2s matches viewport's existing rhythm. */
const DAEMON_LIVENESS_POLL_MS = 2000;

export function parseStartMode(args: string[]): StreamStartMode {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from-now') return { kind: 'now' };
    if (a === '--include-history') return { kind: 'history' };
    if (a === '--from-recent-turn') return { kind: 'recent-turn' };
    if (a === '--from-current-turn') return { kind: 'current-turn' };
    if (a === '--from-offset') {
      const next = args[i + 1];
      const n = Number(next);
      if (!Number.isFinite(n) || n < 0) {
        throw new CliError(`--from-offset requires non-negative integer (got: ${next})`);
      }
      return { kind: 'offset', value: n };
    }
  }
  return { kind: 'recent-turn' };
}

export async function streamCommand(
  deps: ClawCommandDeps,
  name: string,
  options?: StreamOptions,
): Promise<void> {
  const sessionId = makeLauncherSessionId();
  const nextSeq = createLauncherSequencer();

  deps.rootConfig.loadGlobal();

  const target = assertPublishedClaw(deps, name);

  const baseDir = getChestnutRoot();
  const clawDir = target.clawDir;
  const fs = deps.fsFactory(clawDir);
  // audit reused for stream reader internal failure logging; stream session itself does not emit
  const audit = actionAuditFor(clawDir, deps);

  // initial daemon liveness probe — non-blocking warn; tail still proceeds
  // so that consumers can subscribe before daemon starts.
  const pm = createProcessManagerForCLI({ ...deps, baseDir });
  let initialDaemonPid: number | null = null;
  try {
    const daemonDir = resolveClawDaemonDir(target.clawId);
    const daemonLiveness = pm.liveness(daemonDir);
    // phase 523 (review-round4 CLI M): argv-verify + alive 双校验、PID-reuse 防 tail 错进程
    // phase 1773: probe_unavailable/malformed 不伪装 alive（fail-closed warn）
    if (daemonLiveness.kind === 'alive' && isAlive(daemonLiveness.pid) && isPidArgvMatching(daemonLiveness.pid, name)) initialDaemonPid = daemonLiveness.pid;
    else process.stderr.write(`[stream] warning: daemon for "${name}" not running, tailing existing file only\n`);
  } catch {
    // silent: liveness probe failure is non-fatal; degrade to warn
    process.stderr.write(`[stream] warning: failed to probe daemon for "${name}", continuing\n`);
  }

  const mode = options?.startMode ?? { kind: 'recent-turn' };
  let initialOffset: number | undefined;
  // current-turn（phase 2003）：重开 launcher 只恢复启动瞬间仍活跃的 turn——
  // 快照事件在 reader 启动前压缩发射，reader 从同一完整字节边界 tail，
  // 边界两侧不重不漏（快照覆盖 [turn_start, tailOffset)，reader 覆盖 [tailOffset, ∞)）。
  let snapshotEvents: readonly StreamEvent[] | null = null;
  switch (mode.kind) {
    case 'recent-turn': initialOffset = findRecentTurnStartOffset(fs, STREAM_FILE); break;
    case 'current-turn': {
      const snapshot = readCurrentTurnSnapshot(fs, STREAM_FILE);
      initialOffset = snapshot.tailOffset;
      if (snapshot.active) snapshotEvents = snapshot.events;
      break;
    }
    case 'now':         initialOffset = undefined; break;
    case 'history':     initialOffset = 0; break;
    case 'offset':      initialOffset = mode.value; break;
  }

  const mapper = new LauncherEventMapper();
  const activityMapper = new LauncherActivityMapper(name);
  // activity 去抖（phase 2001 引入）：连续相同 phase/label/detail/traceId 不重复发射；
  // 累计摘要每次变化都会放行（phase 2002：thinking/text 流式刷新），相同摘要仍去抖；
  // traceId 计入 key：新 turn/新 send 块的状态变化不被误去抖（phase 2002）；
  // 每个 envelope 仍各自消耗严格递增的 sequence。
  let lastActivityKey: string | null = null;
  const activityKey = (a: { phase: string; label?: string; detail?: string; traceId?: string }): string =>
    `${a.phase}|${a.label ?? ''}|${a.detail ?? ''}|${a.traceId ?? ''}`;
  const reader = createStreamReader(
    fs,
    STREAM_FILE,
    (event) => {
      const activity = activityMapper.map(event);
      if (activity) {
        const key = activityKey(activity);
        if (key !== lastActivityKey) {
          lastActivityKey = key;
          writeLauncherEnvelope(process.stdout, launcherActivityEnvelope(nextSeq(), sessionId, activity));
        }
      }
      const payload = mapper.map(event);
      if (payload) {
        writeLauncherEnvelope(process.stdout, makeLauncherEnvelope(nextSeq(), sessionId, 'event', payload));
      }
    },
    audit,
    { persistent: true },
  );

  // current-turn 快照发射（reader.start 之前，保证 envelope 顺序 = 快照 → live）：
  // 快照原始事件经同一对 mapper 走一遍，只发射最终状态——每个 reply trace 一条累计文本
  // event envelope + 一条最新 activity envelope；不逐条重播历史 delta、不伪造新 delta。
  if (snapshotEvents) {
    const snapMessages = new Map<string, NonNullable<ReturnType<LauncherEventMapper['map']>>>();
    let snapActivity: ReturnType<LauncherActivityMapper['map']> = null;
    for (const event of snapshotEvents) {
      const message = mapper.map(event);
      if (message) snapMessages.set(message.messageId, message);
      const activity = activityMapper.map(event);
      if (activity) snapActivity = activity;
    }
    for (const message of snapMessages.values()) {
      writeLauncherEnvelope(process.stdout, makeLauncherEnvelope(nextSeq(), sessionId, 'event', message));
    }
    if (snapActivity && snapActivity.phase !== 'idle') {
      writeLauncherEnvelope(process.stdout, launcherActivityEnvelope(nextSeq(), sessionId, snapActivity));
      lastActivityKey = activityKey(snapActivity);
    }
  }

  try {
    reader.start(initialOffset);
  } catch (err) {
    // 启动失败：协议 stdout 写 error envelope 后以非零退出（单一终止路径）。
    writeLauncherEnvelope(
      process.stdout,
      launcherErrorEnvelope(nextSeq(), sessionId, 'local', `failed to start stream reader: ${formatErr(err)}`),
    );
    throw new CliError(`Failed to start stream reader for "${name}": ${formatErr(err)}`, { cause: err });
  }

  // shutdown 集中入口：single-flight 缓存 Promise，stop/audit/exit 各执行一次。
  // phase 1377: signal/daemon-dead shutdown 对 reader.stop() rejection 完整 fail-loud
  // （typed audit + stderr + exit 1），并以共享 Promise 保证 reason/exit code 由首次调用冻结。
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: 'sigint' | 'sigterm' | 'daemon_dead'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    let exitCode = 0;
    shutdownPromise = (async (): Promise<void> => {
      // 单一终止路径：daemon_dead 写 error envelope（exit 1）；信号退出写 terminal（exit 0）。
      if (reason === 'daemon_dead') {
        exitCode = 1;
        // daemon 错误 detail 用 claw bar 共享 formatter（phase 2003 Step E）：与 viewport 逐字节一致
        writeLauncherEnvelope(
          process.stdout,
          launcherErrorEnvelope(nextSeq(), sessionId, 'daemon_stopped', formatClawBarError(name, { kind: 'daemon_stopped' })),
        );
      } else {
        writeLauncherEnvelope(
          process.stdout,
          makeLauncherEnvelope(nextSeq(), sessionId, 'terminal', { reason }),
        );
      }
      try {
        await reader.stop();
      } catch (err) {
        exitCode = 1;
        const errorMsg = formatErr(err);
        try {
          audit.write(
            CLI_AUDIT_EVENTS.STREAM_SHUTDOWN_FAILED,
            `claw_id=${name}`,
            `reason=${reason}`,
            `error=${audit.message(errorMsg)}`,
          );
        } catch (auditErr) {
          process.stderr.write(`[stream] failed to record shutdown audit for "${name}" (${reason}): ${formatErr(auditErr)}\n`);
        }
        process.stderr.write(`[stream] shutdown stop failed for "${name}" (${reason}): ${errorMsg}\n`);
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };

  process.on('SIGINT', () => { void shutdown('sigint'); });
  process.on('SIGTERM', () => { void shutdown('sigterm'); });

  // daemon liveness polling — only when initial probe found a live daemon
  if (initialDaemonPid !== null) {
    const interval = setInterval(() => {
      // phase 523 (review-round4 CLI M): argv-verify 防 PID-reuse 让 stream tail 错进程
      if (!isAlive(initialDaemonPid!) || !isPidArgvMatching(initialDaemonPid!, name)) {
        clearInterval(interval);
        void shutdown('daemon_dead');
      }
    }, DAEMON_LIVENESS_POLL_MS);
    interval.unref();   // 不阻 graceful exit
  }
}

export async function runStreamFromArgs(
  deps: ClawCommandDeps,
  name: string,
  args: string[],
): Promise<void> {
  const startMode = parseStartMode(args);
  return streamCommand(deps, name, { startMode });
}
