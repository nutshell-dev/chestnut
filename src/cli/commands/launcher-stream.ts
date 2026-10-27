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
    const message = snapshot.mapper.map(event);
    if (message) writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'message', message));
  }, audit, { persistent: true });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: 'stopped' | 'protocol_error', error?: unknown): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      process.exitCode = reason === 'protocol_error' ? 1 : 0;
      if (error !== undefined) {
        writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'error', {
          class: 'stream_failed', detail: formatErr(error), retryable: reason !== 'protocol_error',
        }));
      }
      writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'terminal', { reason }));
      try {
        await reader.stop();
      } catch (err) {
        process.stderr.write(`[launcher stream] shutdown failed: ${formatErr(err)}\n`);
        process.exitCode = 1;
      }
      // The stopped reader and unref'd interval let the CLI exit naturally.
    })();
    return shutdownPromise;
  };

  try {
    reader.start(snapshot.tailOffset);
  } catch (err) {
    await shutdown('protocol_error', err);
    return;
  }
  process.on('SIGINT', () => { void shutdown('stopped'); });
  process.on('SIGTERM', () => { void shutdown('stopped'); });

  const interval = setInterval(() => {
    const previous = daemon;
    daemon = readLauncherDaemon(deps);
    if (daemon.state === previous.state && daemon.detail === previous.detail) return;
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(nextSeq(), 'daemon', daemon));
    if (previous.state === 'running' && daemon.state !== 'running') {
      clearInterval(interval);
      void shutdown('stopped');
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
