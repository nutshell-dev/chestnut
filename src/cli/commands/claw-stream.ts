/**
 * @module L6.CLI.Claw.Stream
 * Tail a claw's stream.jsonl and emit raw JSONL events to stdout.
 *
 * Long-running foreground process. External viewport clients (launcher /
 * scripts) consume this to render real-time motion / claw activity without
 * binding to TUI.
 *
 * Read-only: no audit emit (per cli/audit-events.ts convention "仅 mutation
 * CLI 加 audit").
 */

import * as path from 'path';
import { makeAgentDirResolver } from '../../core/claw-topology/index.js';

import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getGlobalConfigPath, getClawConfigPath } from '../../foundation/config/index.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { CLAWS_DIR } from '../../foundation/claw-paths.js';
import { createStreamReader, STREAM_FILE, findRecentTurnStartOffset } from '../../foundation/stream/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { isAlive, isPidArgvMatching } from '../../foundation/process-exec/index.js';
import { makeClawId } from '../../foundation/identity/index.js';
import { formatErr } from '../../foundation/utils/index.js';

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
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
  options?: StreamOptions,
): Promise<void> {
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const baseDir = path.dirname(getGlobalConfigPath());
  const clawDir = path.join(baseDir, CLAWS_DIR, name);
  const fs = deps.fsFactory(clawDir);
  // audit reused for stream reader internal failure logging; stream session itself does not emit
  const audit = createSystemAudit(deps.fsFactory(baseDir), clawDir);

  // initial daemon liveness probe — non-blocking warn; tail still proceeds
  // so that consumers can subscribe before daemon starts.
  const pm = createProcessManagerForCLI({ ...deps, resolveAgentDir: makeAgentDirResolver() });
  let initialDaemonPid: number | null = null;
  try {
    const stored = await pm.readPid(makeClawId(name));
    // phase 523 (review-round4 CLI M): argv-verify + alive 双校验、PID-reuse 防 tail 错进程
    if (stored && isAlive(stored.pid) && isPidArgvMatching(stored.pid, name)) initialDaemonPid = stored.pid;
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

  // shutdown 集中入口、防 double-shutdown / 保 reader.stop 顺序
  let shuttingDown = false;
  let exitCode = 0;
  const shutdown = async (reason: 'sigint' | 'sigterm' | 'daemon_dead'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason === 'daemon_dead') {
      process.stdout.write(JSON.stringify({ type: 'daemon_stopped' }) + '\n');
      exitCode = 1;
    }
    await reader.stop();
    process.exit(exitCode);
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
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
  args: string[],
): Promise<void> {
  const startMode = parseStartMode(args);
  return streamCommand(deps, name, { startMode });
}
