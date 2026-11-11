import type { LLMConfigurationAdmin } from '../../core/llm-configuration/index.js';
import { getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import {
  makeLauncherV2Envelope,
  parseLauncherStartRequest,
  writeLauncherV2Envelope,
  type LauncherStartRequest,
  type LauncherV2Envelope,
} from '../../cli-protocol/index.js';
import type { EnsureSupervision } from '../supervision-policy.js';
import { ensureStartBootstrap, getOnboardingStatus } from '../start-bootstrap.js';
import { readLauncherDaemon, type LauncherCommandDeps } from './launcher-runtime.js';

/** Matches ProcessManager's existing 30s boot deadline; callers may shorten it explicitly. */
const DEFAULT_LAUNCHER_START_TIMEOUT_MS = 30_000;

export interface LauncherStartDeps extends LauncherCommandDeps {
  llmConfiguration: Pick<LLMConfigurationAdmin, 'loadGlobal' | 'patchPrimary'>;
}

export async function executeLauncherStart(
  deps: LauncherStartDeps,
  request: LauncherStartRequest,
  runtime: { ensureSupervision: EnsureSupervision; audit?: AuditLog },
): Promise<LauncherV2Envelope> {
  if (deps.rootConfig.getInitializationState() !== 'ready') {
    throw new Error('workspace initialization is not ready; run launcher setup first');
  }
  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const result = await ensureStartBootstrap(deps, runtime, {
    interactive: false,
    languageMode: 'auto',
    firstRun: false,
    onboarding: getOnboardingStatus(motionDir, deps),
    languageSample: request.languageSample?.trim() || undefined,
    daemonReadyTimeoutMs: request.timeoutMs ?? DEFAULT_LAUNCHER_START_TIMEOUT_MS,
  });
  const daemon = readLauncherDaemon(deps);
  if (daemon.state !== 'running') throw new Error(daemon.detail ?? `daemon state is ${daemon.state}`);
  return makeLauncherV2Envelope(1, 'daemon', {
    state: 'running',
    detail: 'ready',
    onboarding: result.onboarding.state,
  });
}

export async function launcherStartCommand(
  deps: LauncherStartDeps,
  runtime: { ensureSupervision: EnsureSupervision; audit?: AuditLog },
): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  let request: LauncherStartRequest;
  try {
    request = parseLauncherStartRequest(input.trim() || '{}');
  } catch (err) {
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(1, 'error', {
      class: 'protocol_error', detail: formatErr(err), retryable: false,
    }));
    return;
  }
  try {
    writeLauncherV2Envelope(process.stdout, await executeLauncherStart(deps, request, runtime));
  } catch (err) {
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(1, 'error', {
      class: 'runtime_not_ready', detail: formatErr(err), retryable: true,
    }));
  }
}
