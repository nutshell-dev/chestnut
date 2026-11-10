import * as path from 'path';
import type { RootConfigAdmin } from '../assembly/index.js';
import { createMotionContractActionContext } from '../assembly/index.js';
import { createDaemonSpawnOptions, ensureMotionLLMIdentity } from '../daemon/index.js';
import {
  CLAW_SPEC_FILE,
  getChestnutRoot,
  getNamedSubrootDir,
  makeChestnutRoot,
} from '../foundation/claw-identity/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { createClawNotifier } from '../foundation/messaging/index.js';
import { createProcessManagerForCLI } from '../foundation/process-manager/index.js';
import { MOTION_CLAW_ID, makeClawNotifyTargetResolver, resolveClawDaemonDir } from '../core/claw-topology/index.js';
import {
  ContractValidationError,
  ONBOARDING_CONTRACT_ID,
  resolveOnboardingIdentity,
  type ContractYaml,
  type OnboardingIdentityVerdict,
  type OnboardingStatus,
} from '../core/contract/index.js';
import {
  ONBOARDING_FIRST_CLAW_SUBTASK_DESCRIPTION,
  ONBOARDING_FIRST_CONTRACT_SUBTASK_DESCRIPTION,
  ONBOARDING_IDENTITY_SUBTASK_DESCRIPTION,
  ONBOARDING_LANG_INSTRUCTION_AUTO,
  ONBOARDING_READY_SUBTASK_DESCRIPTION,
  ONBOARDING_SOUL_SUBTASK_DESCRIPTION,
  ONBOARDING_USER_SUBTASK_DESCRIPTION,
  onboardingContractCreatedBody,
  onboardingContractResumedBody,
  onboardingLangInstructionTyped,
  onboardingLanguageSubtaskDescription,
} from '../templates/messages/index.js';
import { actionAuditFor } from './action-scope.js';
import { CLI_AUDIT_EVENTS } from './audit-events.js';
import { ensureStartLLMVerified, type VerifiedLLMConfig } from './start-llm-gate.js';
import type { EnsureSupervision } from './supervision-policy.js';
import { initCommand as motionInitCommand } from './commands/motion.js';

export interface StartBootstrapDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'loadGlobal' | 'patchPrimary' | 'getInitializationState'>;
}

export interface StartBootstrapRuntime {
  audit?: AuditLog;
  ensureSupervision: EnsureSupervision;
}

export interface StartBootstrapOptions {
  interactive: boolean;
  languageMode: 'auto';
  firstRun: boolean;
  onboarding: OnboardingStatus;
  preVerified?: VerifiedLLMConfig;
  /** Interactive/non-interactive CLI adapter; launcher deliberately omits this. */
  resolveLanguage?: () => Promise<string>;
  /** Optional launcher-provided sample; blank/omitted preserves auto behavior. */
  languageSample?: string;
  daemonReadyTimeoutMs?: number;
}

export interface StartBootstrapResult {
  verified: VerifiedLLMConfig;
  daemon: { state: 'running'; generation?: string };
  onboarding: { state: 'complete' | 'created' | 'resumed' | 'pending'; contractId?: string };
}

export function buildOnboardingSubtasks(language: string): Array<{ id: string; description: string }> {
  const langInstruction = language === 'auto'
    ? ONBOARDING_LANG_INSTRUCTION_AUTO
    : onboardingLangInstructionTyped(language);
  return [
    { id: 'language', description: onboardingLanguageSubtaskDescription(langInstruction) },
    { id: 'identity', description: ONBOARDING_IDENTITY_SUBTASK_DESCRIPTION },
    { id: 'user', description: ONBOARDING_USER_SUBTASK_DESCRIPTION },
    { id: 'soul', description: ONBOARDING_SOUL_SUBTASK_DESCRIPTION },
    { id: 'first-claw', description: ONBOARDING_FIRST_CLAW_SUBTASK_DESCRIPTION },
    { id: 'first-contract', description: ONBOARDING_FIRST_CONTRACT_SUBTASK_DESCRIPTION },
    { id: 'ready', description: ONBOARDING_READY_SUBTASK_DESCRIPTION },
  ];
}

export function getOnboardingStatus(
  motionDir: string,
  deps: { fsFactory: (baseDir: string) => FileSystem; audit?: AuditLog },
): OnboardingStatus {
  const verdict = resolveOnboardingIdentity(motionDir, deps);
  if (verdict.kind === 'absent') return { state: 'not_found' };
  if (verdict.kind === 'unique') {
    return verdict.state === 'complete'
      ? { state: 'complete' }
      : { state: 'in_progress', contractId: verdict.contractId, pending: verdict.pending };
  }
  throw onboardingIdentityConflictError(verdict);
}

function onboardingIdentityConflictError(
  verdict: Extract<OnboardingIdentityVerdict, { kind: 'conflict' }>,
): Error {
  return new Error(
    `onboarding identity conflict: ${verdict.detail}; ` +
    `candidates=[${verdict.candidates.join(', ')}]; evidence preserved, not overwritten`,
  );
}

interface ContractSystemLike {
  create(contract: ContractYaml): Promise<string>;
  recoverCreation(contractId: string): Promise<'absent' | 'published' | 'recovered' | 'failed'>;
}

/** Stable-id onboarding creation/recovery authority shared by both start entry points. */
export async function ensureOnboardingContract(
  deps: StartBootstrapDeps,
  action: { system: Pick<ContractSystemLike, 'create' | 'recoverCreation'> },
  motionDir: string,
  contract: ContractYaml,
): Promise<{ contractId: string; created: boolean }> {
  const verdict = resolveOnboardingIdentity(motionDir, deps);
  if (verdict.kind === 'conflict') throw onboardingIdentityConflictError(verdict);
  if (verdict.kind === 'unique') return { contractId: verdict.contractId, created: false };

  try {
    const contractId = await action.system.create({ ...contract, id: ONBOARDING_CONTRACT_ID });
    return { contractId, created: true };
  } catch (err) {
    if (!(err instanceof ContractValidationError) || err.field !== 'id' || err.kind !== 'already_exists') {
      throw err;
    }
  }

  const ONBOARDING_REREAD_ATTEMPTS = 20;
  const ONBOARDING_REREAD_DELAY_MS = 100;
  for (let attempt = 0; attempt < ONBOARDING_REREAD_ATTEMPTS; attempt++) {
    const reread = resolveOnboardingIdentity(motionDir, deps);
    if (reread.kind === 'unique') return { contractId: reread.contractId, created: false };
    if (reread.kind === 'conflict') throw onboardingIdentityConflictError(reread);
    await new Promise<void>(resolve => setTimeout(resolve, ONBOARDING_REREAD_DELAY_MS));
  }

  const recovered = await action.system.recoverCreation(ONBOARDING_CONTRACT_ID);
  const finalVerdict = resolveOnboardingIdentity(motionDir, deps);
  if (finalVerdict.kind === 'unique') return { contractId: finalVerdict.contractId, created: false };
  if (finalVerdict.kind === 'conflict') throw onboardingIdentityConflictError(finalVerdict);
  throw new Error(
    `onboarding creation indeterminate: claim for "${ONBOARDING_CONTRACT_ID}" exists ` +
    `but no readable onboarding contract (recovery=${recovered}); evidence preserved, not overwritten`,
  );
}

type ClawNotifier = ReturnType<typeof createClawNotifier>;

export async function ensureOnboardingAndNotify(
  deps: StartBootstrapDeps,
  input: {
    motionDir: string;
    onboarding: Exclude<OnboardingStatus, { state: 'complete' }>;
    firstRun: boolean;
    language: string;
    clawNotifier: ClawNotifier;
  },
): Promise<{ state: 'created' | 'resumed'; contractId: string }> {
  const { motionDir, onboarding, firstRun, language, clawNotifier } = input;
  let result: { contractId: string; created: boolean };
  if (onboarding.state === 'not_found') {
    const action = await createMotionContractActionContext(deps, { registerSummonVerifyPolicy: true });
    try {
      result = await ensureOnboardingContract(deps, action, motionDir, {
        schema_version: 1,
        title: 'Onboarding',
        goal: firstRun
          ? 'Get to know the user and establish your identity before anything else. No interrogation — just talk.'
          : 'Get to know the user and establish your identity before anything else.',
        subtasks: buildOnboardingSubtasks(language),
        verification: [],
      });
    } finally {
      action.dispose();
    }
  } else {
    result = { contractId: String(onboarding.contractId), created: false };
  }

  if (result.created) {
    clawNotifier.notify(MOTION_CLAW_ID, {
      type: 'contract_created',
      source: 'system',
      priority: 'high',
      body: onboardingContractCreatedBody({ contractId: result.contractId }),
      idPrefix: 'start',
      // phase 2094 Step B: 让排队中的工作指令带可查询契约身份（Runtime 侧 owner 识别入口消费）
      metadata: { contract_id: result.contractId },
    });
  } else {
    const status = onboarding.state === 'not_found' ? getOnboardingStatus(motionDir, deps) : onboarding;
    clawNotifier.notify(MOTION_CLAW_ID, {
      type: 'contract_resume',
      source: 'system',
      priority: 'high',
      body: onboardingContractResumedBody({
        contractId: String(result.contractId),
        pendingSubtasks: status.pending ?? [],
      }),
      idPrefix: 'start',
      // phase 2094 Step B: resume 同样补齐契约身份（body/priority/发送时机不变）
      metadata: { contract_id: result.contractId },
    });
  }
  return { state: result.created ? 'created' : 'resumed', contractId: result.contractId };
}

/** Shared non-TUI startup owner. CLI adapters only provide language input and presentation. */
export async function ensureStartBootstrap(
  deps: StartBootstrapDeps,
  runtime: StartBootstrapRuntime,
  options: StartBootstrapOptions,
): Promise<StartBootstrapResult> {
  const verified = await ensureStartLLMVerified(deps, {
    audit: runtime.audit,
    interactive: options.interactive,
    preVerified: options.preVerified,
  });
  await runtime.ensureSupervision();

  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const notifyFs = deps.fsFactory(motionDir);
  const notifyAudit = actionAuditFor(motionDir, deps);
  const notifyChestnutRoot = makeChestnutRoot(path.dirname(motionDir));
  const clawNotifier = createClawNotifier({
    fs: notifyFs,
    audit: notifyAudit,
    resolveTarget: makeClawNotifyTargetResolver(notifyChestnutRoot),
  });
  const motionSpawnOptions = createDaemonSpawnOptions({
    clawId: MOTION_CLAW_ID,
    agentDir: motionDir,
    chestnutRoot: getChestnutRoot(),
    expectedLLMIdentity: verified.snapshot.identity,
  });
  if (!deps.fsFactory(motionDir).existsSync(CLAW_SPEC_FILE)) await motionInitCommand(deps, true);

  const pm = createProcessManagerForCLI({ ...deps, baseDir: getChestnutRoot() });
  const motionDaemonDir = resolveClawDaemonDir(MOTION_CLAW_ID);
  const daemonReady = pm.ensureRunning(motionDaemonDir, motionSpawnOptions);
  const awaitVerifiedDaemonReady = async (): Promise<void> => {
    const timeoutMs = options.daemonReadyTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (timeoutMs === undefined) {
        await daemonReady;
      } else {
        await Promise.race([
          daemonReady,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Motion readiness timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      }
      ensureMotionLLMIdentity(pm, motionDaemonDir, verified.snapshot.identity);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  if (options.onboarding.state === 'complete') {
    await awaitVerifiedDaemonReady();
    return { verified, daemon: { state: 'running' }, onboarding: { state: 'complete' } };
  }

  let language = 'auto';
  if (options.firstRun && options.onboarding.state === 'not_found') {
    daemonReady.catch((err: unknown) => {
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      notifyAudit?.write(
        CLI_AUDIT_EVENTS.DAEMON_SPAWN_RACE_FAILED,
        'context=first_run_parallel_pickLanguage',
        `error=${errMsg}`,
      );
    });
    language = options.resolveLanguage ? await options.resolveLanguage() : 'auto';
  }

  if (options.languageSample?.trim()) language = options.languageSample.trim();

  await awaitVerifiedDaemonReady();
  const onboarding = await ensureOnboardingAndNotify(deps, {
    motionDir,
    onboarding: options.onboarding,
    firstRun: options.firstRun,
    language,
    clawNotifier,
  });
  runtime.audit?.write(CLI_AUDIT_EVENTS.DAEMON_START);
  return { verified, daemon: { state: 'running' }, onboarding };
}
