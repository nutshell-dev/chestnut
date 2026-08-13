/**
 * @module L6.CLI.Claw.Stream
 * Tail a claw's stream.jsonl and emit raw JSONL events to stdout.
 *
 * Long-running foreground process. External viewport clients (launcher /
 * scripts) consume this to render real-time motion / claw activity without
 * binding to TUI.
 *
 * Emits stream-reader lifecycle/fault audit events via createStreamReader.
 */

import * as path from 'path';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';

import { getChestnutRoot, getClawConfigPath, getRelativeClawDir } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';

import { createStreamReader, STREAM_FILE, findRecentTurnStartOffset } from '../../foundation/stream/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { isAlive, isPidArgvMatching } from '../../foundation/process-exec/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

export type StreamStartMode =
  | { kind: 'recent-turn' }
  | { kind: 'now' }
  | { kind: 'history' }
  | { kind: 'offset'; value: number };

export interface StreamOptions {
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
  deps.rootConfig.loadGlobal();

  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const baseDir = getChestnutRoot();
  const clawDir = path.join(baseDir, getRelativeClawDir(name));
  const fs = deps.fsFactory(clawDir);
  // audit reused for stream reader internal failure logging; stream session itself does not emit
  const audit = createSystemAudit(deps.fsFactory(baseDir), clawDir);

  // initial daemon liveness probe — non-blocking warn; tail still proceeds
  // so that consumers can subscribe before daemon starts.
  const pm = createProcessManagerForCLI({ ...deps, baseDir });
  let initialDaemonPid: number | null = null;
  try {
    const daemonDir = resolveClawDaemonDir(makeClawId(name));
    const { alive, pid } = pm.getAliveStatus(daemonDir);
    // phase 523 (review-round4 CLI M): argv-verify + alive 双校验、PID-reuse 防 tail 错进程
    if (alive && pid !== undefined && isAlive(pid) && isPidArgvMatching(pid, name)) initialDaemonPid = pid;
    else process.stderr.write(`[stream] warning: daemon for "${name}" not running, tailing existing file only\n`);
  } catch {
    // silent: liveness probe failure is non-fatal; degrade to warn
    process.stderr.write(`[stream] warning: failed to probe daemon for "${name}", continuing\n`);
  }

  const mode = options?.startMode ?? { kind: 'recent-turn' };
  let initialOffset: number | undefined;
  switch (mode.kind) {
    case 'recent-turn': initialOffset = findRecentTurnStartOffset(fs, STREAM_FILE); break;
    case 'now':         initialOffset = undefined; break;
    case 'history':     initialOffset = 0; break;
    case 'offset':      initialOffset = mode.value; break;
  }

  const reader = createStreamReader(
    fs,
    STREAM_FILE,
    (event) => process.stdout.write(JSON.stringify(event) + '\n'),
    audit,
    { persistent: true },
  );

  try {
    reader.start(initialOffset);
  } catch (err) {
    throw new CliError(`Failed to start stream reader for "${name}": ${formatErr(err)}`, { cause: err });
  }

  // shutdown 集中入口：single-flight 缓存 Promise，stop/audit/exit 各执行一次。
  // phase 1377: signal/daemon-dead shutdown 对 reader.stop() rejection 完整 fail-loud
  // （typed audit + stderr + exit 1），并以共享 Promise 保证 reason/exit code 由首次调用冻结。
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: 'sigint' | 'sigterm' | 'daemon_dead'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    let exitCode = 0;
    let terminalEvent: { type: 'daemon_stopped' } | undefined;
    if (reason === 'daemon_dead') {
      terminalEvent = { type: 'daemon_stopped' };
      exitCode = 1;
    }
    shutdownPromise = (async (): Promise<void> => {
      if (terminalEvent) {
        process.stdout.write(JSON.stringify(terminalEvent) + '\n');
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
