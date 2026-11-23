/**
 * start command - interactive adapter for the shared startup bootstrap.
 * Workspace/setup and readline remain here; runtime and onboarding are shared
 * with launcher start through start-bootstrap.ts.
 */

import * as readline from 'readline';
import type { InitializationInspection, InitializationState, RootConfigAdmin } from '../../assembly/index.js';
import { MOTION_CLAW_ID, requireMotionAccess } from '../../core/claw-topology/index.js';
import { getCapturedCliMotionAccess } from '../motion-cli-guard.js';
import { getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { runFirstRunSetup, runNonInteractiveFirstRun } from '../first-run-setup.js';
import {
  LLMConfigurationNotFoundError,
  type LLMConfigurationAdmin,
} from '../../core/llm-configuration/index.js';
import { CliError } from '../errors.js';
import {
  applyStartLLMOptions,
  validateStartLLMOptions,
  START_GATE_EXIT_CODE,
  type StartLLMOptions,
  type VerifiedLLMConfig,
} from '../start-llm-gate.js';
import {
  ensureStartBootstrap,
  getOnboardingStatus,
  migrateStartLegacyApiKeys,
  type StartBootstrapDeps,
} from '../start-bootstrap.js';
import type { EnsureSupervision } from '../supervision-policy.js';
import { chatCommand as motionChatCommand } from './motion.js';

export {
  buildOnboardingSubtasks,
  ensureOnboardingContract,
  getOnboardingStatus,
} from '../start-bootstrap.js';

type StartCommandDeps = StartBootstrapDeps & {
  rootConfig: StartBootstrapDeps['rootConfig'] & Pick<RootConfigAdmin,
    'isInitialized' | 'saveGlobalExclusive' | 'completeInitialization'>;
  llmConfiguration: StartBootstrapDeps['llmConfiguration'] & Pick<LLMConfigurationAdmin, 'store'>;
};
interface StartCommandRuntime {
  audit?: AuditLog;
  ensureSupervision: EnsureSupervision;
}

export async function pickLanguage(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log('\nSelect language / 选择语言:');
    console.log('type any word for auto-detect (e.g. hello, 你好)\n');
    rl.question('> ', (answer) => {
      rl.close();
      const t = answer.trim();
      resolve(t || 'auto');
    });
  });
}

/** Atomic snapshot of initialization + onboarding state. */
export function getInitializationSnapshot(deps: StartCommandDeps & { audit?: AuditLog }, motionDir: string): {
  isInitialized: boolean;
  initialization: InitializationState;
  inspection: InitializationInspection;
  onboarding: ReturnType<typeof getOnboardingStatus>;
} {
  const inspection = deps.rootConfig.inspectInitialization();
  const initialization = inspection.state;
  return {
    isInitialized: initialization === 'ready',
    initialization,
    inspection,
    onboarding: getOnboardingStatus(motionDir, deps),
  };
}

export async function startCommand(
  deps: StartCommandDeps,
  runtime: StartCommandRuntime,
  llmOptions: StartLLMOptions = {},
): Promise<void> {
  requireMotionAccess(getCapturedCliMotionAccess('start'), 'start', 'start');
  try {
    await _start(deps, runtime, llmOptions);
  } catch (error) {
    const code = error instanceof CliError ? error.code : 1;
    throw new CliError('chestnut start failed: ' + (formatErr(error)), { cause: error, code });
  }
}

async function _start(deps: StartCommandDeps, runtime: StartCommandRuntime, llmOptions: StartLLMOptions): Promise<void> {
  const { audit } = runtime;
  validateStartLLMOptions(llmOptions);
  if (deps.rootConfig.isInitialized?.()) await migrateStartLegacyApiKeys(deps);

  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const snapshot = getInitializationSnapshot({ ...deps, audit }, motionDir);
  let needsSetup = snapshot.initialization === 'absent';
  if (snapshot.initialization === 'in_progress') {
    try {
      deps.llmConfiguration.store.read();
    } catch (error) {
      if (!(error instanceof LLMConfigurationNotFoundError)) throw error;
      needsSetup = true;
    }
  }
  const wasFirstRun = snapshot.initialization === 'absent';
  const interactive = !llmOptions.nonInteractive && process.stdin.isTTY !== false;
  let preVerified: VerifiedLLMConfig | undefined;
  if (needsSetup) {
    const outcome = interactive
      ? await runFirstRunSetup(deps, { audit })
      : await runNonInteractiveFirstRun(deps, llmOptions, audit);
    if (outcome.kind === 'cancelled') {
      throw new CliError('Setup cancelled by user; start aborted', { code: START_GATE_EXIT_CODE });
    }
    if (outcome.kind === 'verified') preVerified = outcome.verified;
  } else if (snapshot.initialization === 'in_progress') {
    deps.rootConfig.completeInitialization();
  } else if (snapshot.inspection.state === 'invalid') {
    throw new CliError(
      `Workspace initialization structure is invalid (${snapshot.inspection.reason}). ` +
      'Inspect .chestnut/ manually; start will not overwrite it.',
    );
  }
  if (!needsSetup && llmOptions.nonInteractive) await applyStartLLMOptions(deps, llmOptions);

  const onboarding = snapshot.onboarding;
  await ensureStartBootstrap(deps, runtime, {
    interactive,
    languageMode: 'auto',
    firstRun: wasFirstRun || needsSetup,
    onboarding,
    preVerified,
    resolveLanguage: (wasFirstRun || needsSetup) && onboarding.state === 'not_found'
      ? async () => llmOptions.nonInteractive ? (llmOptions.language ?? 'auto') : pickLanguage()
      : undefined,
  });
  await motionChatCommand(deps);
}
