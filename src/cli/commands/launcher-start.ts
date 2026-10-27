import type { RootConfigAdmin } from '../../assembly/index.js';
import { CLAW_SPEC_FILE, getChestnutRoot, getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID, resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { createDaemonSpawnOptions, ensureMotionLLMIdentity } from '../../daemon/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import {
  makeLauncherV2Envelope,
  parseLauncherStartRequest,
  writeLauncherV2Envelope,
  type LauncherStartRequest,
  type LauncherV2Envelope,
} from '../../cli-protocol/index.js';
import { ensureStartLLMVerified } from '../start-llm-gate.js';
import type { EnsureSupervision } from '../supervision-policy.js';
import { initCommand as motionInitCommand } from './motion.js';
import { readLauncherDaemon, type LauncherCommandDeps } from './launcher-runtime.js';

/** Matches ProcessManager's existing 30s boot deadline; callers may shorten it explicitly. */
const DEFAULT_LAUNCHER_START_TIMEOUT_MS = 30_000;

export interface LauncherStartDeps extends LauncherCommandDeps {
  rootConfig: LauncherCommandDeps['rootConfig'] & Pick<RootConfigAdmin, 'patchPrimary'>;
}

export async function executeLauncherStart(
  deps: LauncherStartDeps,
  request: LauncherStartRequest,
  runtime: { ensureSupervision: EnsureSupervision; audit?: AuditLog },
): Promise<LauncherV2Envelope> {
  if (deps.rootConfig.getInitializationState() !== 'ready') {
    throw new Error('workspace initialization is not ready; run launcher setup first');
  }
  const verified = await ensureStartLLMVerified(deps, { audit: runtime.audit, interactive: false });
  await runtime.ensureSupervision();
  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  if (!deps.fsFactory(motionDir).existsSync(CLAW_SPEC_FILE)) await motionInitCommand(deps, true);
  const pm = createProcessManagerForCLI({ ...deps, baseDir: getChestnutRoot() });
  const daemonDir = resolveClawDaemonDir(MOTION_CLAW_ID);
  const ready = pm.ensureRunning(daemonDir, createDaemonSpawnOptions({
    clawId: MOTION_CLAW_ID,
    agentDir: motionDir,
    chestnutRoot: getChestnutRoot(),
    expectedLLMIdentity: verified.snapshot.identity,
  }));
  const timeoutMs = request.timeoutMs ?? DEFAULT_LAUNCHER_START_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Motion readiness timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    ensureMotionLLMIdentity(pm, daemonDir, verified.snapshot.identity);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const daemon = readLauncherDaemon(deps);
  if (daemon.state !== 'running') throw new Error(daemon.detail ?? `daemon state is ${daemon.state}`);
  return makeLauncherV2Envelope(1, 'daemon', { state: 'running', detail: 'ready' });
}

export async function launcherStartCommand(
  deps: LauncherStartDeps,
  runtime: { ensureSupervision: EnsureSupervision; audit?: AuditLog },
): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  try {
    const request = parseLauncherStartRequest(input.trim() || '{}');
    writeLauncherV2Envelope(process.stdout, await executeLauncherStart(deps, request, runtime));
  } catch (err) {
    writeLauncherV2Envelope(process.stdout, makeLauncherV2Envelope(1, 'error', {
      class: 'runtime_not_ready', detail: formatErr(err), retryable: true,
    }));
  }
}
