import { actionAuditFor } from '../action-scope.js';
import { createStreamReader, STREAM_FILE } from '../../foundation/stream/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  createLauncherSequencer,
  makeLauncherV2Envelope,
  parseLauncherStreamRequest,
  writeLauncherV2Envelope,
  type LauncherStreamRequest,
} from '../../cli-protocol/index.js';
import { readLauncherDaemon, readLauncherSnapshot, type LauncherCommandDeps } from './launcher-runtime.js';

const DAEMON_LIVENESS_POLL_MS = 2000;

export async function runLauncherStream(
  deps: LauncherCommandDeps,
  request: LauncherStreamRequest,
): Promise<void> {
  const nextSeq = createLauncherSequencer();
  const snapshot = readLauncherSnapshot(deps);
  if (request.afterSequence !== undefined) {
    snapshot.payload.afterSequence = request.afterSequence;
    snapshot.payload.resync = 'resync_required';
  }
  writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'snapshot', snapshot.payload));

  let daemon = readLauncherDaemon(deps);
  writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'daemon', daemon));
  // A daemon already confirmed stopped is terminal, including after an EOF reconnect.
  // Do not leave the consumer waiting on a reader that can never make progress.
  if (daemon.state === 'stopped') {
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'terminal', { reason: 'stopped' }));
    process.exitCode = 0;
    return;
  }
  const fs = deps.fsFactory(snapshot.clawDir);
  const audit = actionAuditFor(snapshot.clawDir, deps);
  let lastActivityKey = snapshot.payload.activity
    ? JSON.stringify(snapshot.payload.activity)
    : '';
  const reader = createStreamReader(fs, STREAM_FILE, (event) => {
    const activity = snapshot.activityMapper.map(event);
    if (activity) {
      const key = JSON.stringify(activity);
      if (key !== lastActivityKey) {
        lastActivityKey = key;
        writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'activity', activity));
      }
    }
    for (const message of snapshot.mapper.mapAll(event)) {
      writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'message', message));
    }
  }, audit, { persistent: true });

  let interval: ReturnType<typeof setInterval> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const signalHandler = () => { requestShutdown('stopped'); };
  const shutdown = (reason: 'stopped' | 'protocol_error', error?: unknown): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    // Publish the latch before any output/cleanup can re-enter shutdown.
    shutdownPromise = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const recordShutdownError = (cause: unknown): void => {
        failures.push(cause);
        process.exitCode = 1;
      };
      process.exitCode = reason === 'protocol_error' ? 1 : 0;
      if (interval !== undefined) clearInterval(interval);
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
      if (error !== undefined) {
        try {
          writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'error', {
            class: 'stream_failed', detail: formatErr(error), retryable: reason !== 'protocol_error',
          }));
        } catch (outputError) { recordShutdownError(outputError); }
      }
      try {
        writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'terminal', { reason }));
      } catch (outputError) { recordShutdownError(outputError); }
      try {
        await reader.stop();
      } catch (stopError) { recordShutdownError(stopError); }
      if (failures.length > 0) {
        process.exitCode = 1;
        const causes = error === undefined ? failures : [error, ...failures];
        const detail = causes.map(cause => formatErr(cause)).join('; ');
        try {
          process.stderr.write(`[launcher stream] shutdown failed: ${detail}\n`);
        } catch (diagnosticError) {
          throw new AggregateError([...causes, diagnosticError],
            `Launcher stream shutdown and diagnostic output failed: ${detail}; ${formatErr(diagnosticError)}`,
            { cause: causes[0] });
        }
      }
    });
    return shutdownPromise;
  };
  const requestShutdown = (reason: 'stopped' | 'protocol_error', error?: unknown): void => {
    if (shutdownPromise) return;
    void shutdown(reason, error).catch(failure => {
      // Both output channels failed. Keep the combined cause visible to the process boundary.
      queueMicrotask(() => { throw failure; });
    });
  };

  try {
    reader.start(snapshot.tailOffset);
  } catch (err) {
    await shutdown('protocol_error', err);
    return;
  }
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  interval = setInterval(() => {
    const previous = daemon;
    daemon = readLauncherDaemon(deps);
    if (daemon.state === previous.state && daemon.detail === previous.detail) return;
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'daemon', daemon));
    if (previous.state === 'running' && daemon.state !== 'running') {
      requestShutdown('stopped');
    }
  }, DAEMON_LIVENESS_POLL_MS);
  interval.unref();
}

export async function launcherStreamCommand(
  deps: LauncherCommandDeps,
  initialRequest: LauncherStreamRequest = {},
): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  try {
    const request = input.trim()
      ? parseLauncherStreamRequest(input.trim())
      : parseLauncherStreamRequest(JSON.stringify(initialRequest));
    await runLauncherStream(deps, request);
  } catch (err) {
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(1, 'error', {
      class: 'protocol_error', detail: formatErr(err), retryable: false,
    }));
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(2, 'terminal', { reason: 'protocol_error' }));
  }
}
