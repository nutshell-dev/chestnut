import {
  LAUNCHER_SETUP_PROTOCOL,
  makeLauncherV2Envelope,
  parseLauncherStatusRequest,
  writeLauncherV2Envelope,
  type LauncherV2Envelope,
} from '../../cli-protocol/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { readLauncherSnapshot, type LauncherCommandDeps } from './launcher-runtime.js';
import { executeLauncherSetup, type LauncherSetupDeps } from './launcher-setup.js';

export type LauncherStatusDeps = LauncherSetupDeps & LauncherCommandDeps;

export async function executeLauncherStatus(
  deps: LauncherStatusDeps,
): Promise<LauncherV2Envelope> {
  const snapshot = readLauncherSnapshot(deps).payload;
  const setup = await executeLauncherSetup(deps, {
    protocolVersion: LAUNCHER_SETUP_PROTOCOL,
    requestId: 'launcher-status',
    action: 'status',
  });
  if (setup.kind === 'error') throw new Error(setup.payload.message?.toString() ?? 'setup status failed');
  snapshot.setup = setup.payload;
  return makeLauncherV2Envelope(1, 'snapshot', snapshot);
}

export async function launcherStatusCommand(deps: LauncherStatusDeps): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  try {
    parseLauncherStatusRequest(input.trim() || '{}');
    writeLauncherV2Envelope(process.stdout, await executeLauncherStatus(deps));
  } catch (err) {
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(1, 'error', {
      class: 'status_failed', detail: formatErr(err), retryable: false,
    }));
  }
}
