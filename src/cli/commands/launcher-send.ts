import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import {
  makeLauncherV2Envelope,
  parseLauncherSendRequest,
  writeLauncherV2Envelope,
  type LauncherSendRequest,
  type LauncherV2Envelope,
} from '../../cli-protocol/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { deliverClawMessage } from './claw-send.js';
import { readLauncherDaemon, type LauncherCommandDeps } from './launcher-runtime.js';

export async function executeLauncherSend(
  deps: LauncherCommandDeps,
  request: LauncherSendRequest,
): Promise<LauncherV2Envelope> {
  await deliverClawMessage(deps, MOTION_CLAW_ID, request.text, { requestId: request.requestId });
  const daemon = readLauncherDaemon(deps);
  return makeLauncherV2Envelope(1, 'send_ack', {
    requestId: request.requestId,
    delivery: daemon.state === 'running' ? 'queued' : 'persisted',
    daemon: daemon.state,
  });
}

export async function launcherSendCommand(deps: LauncherCommandDeps): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  let requestId = 'unknown';
  try {
    const request = parseLauncherSendRequest(input.trim());
    requestId = request.requestId;
    writeLauncherV2Envelope(process.stdout, await executeLauncherSend(deps, request));
  } catch (err) {
    const daemon = readLauncherDaemon(deps);
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(1, 'send_ack', {
      requestId, delivery: 'rejected', daemon: daemon.state,
    }));
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(2, 'error', {
      class: 'send_rejected', detail: formatErr(err), retryable: false, requestId,
    }));
  }
}
