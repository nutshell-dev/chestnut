/**
 * start command - One-shot entry point
 *
 * Initializes workspace and Motion if needed, then opens Motion chat.
 * - First run: creates Onboarding contract for onboarding
 * - Onboarding complete: goes straight to chat
 * - Partial onboarding: resumes with a reminder
 */

import { getWorkspaceRoot, getChestnutRoot } from '../../foundation/claw-identity/index.js';
import { makeChestnutRoot } from '../../foundation/claw-identity/index.js';
// CLAWS_DIR removed: phase 263
import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import * as readline from 'readline';

import type { RootConfigAdmin } from '../../assembly/index.js';
import { CLAW_SPEC_FILE } from '../../foundation/claw-identity/index.js';
import { getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { initCommand } from './init.js';
import {
  initCommand as motionInitCommand,
  chatCommand as motionChatCommand,
} from './motion.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';

import { createMotionContractActionContext } from '../../assembly/index.js';
import { actionAuditFor } from '../action-scope.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { makeClawNotifyTargetResolver } from '../../core/claw-topology/index.js';
import { createClawNotifier } from '../../foundation/messaging/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import {
  onboardingContractCreatedBody,
  onboardingContractResumedBody,
  onboardingLangInstructionTyped,
  onboardingLanguageSubtaskDescription,
  ONBOARDING_LANG_INSTRUCTION_AUTO,
  ONBOARDING_IDENTITY_SUBTASK_DESCRIPTION,
  ONBOARDING_USER_SUBTASK_DESCRIPTION,
  ONBOARDING_SOUL_SUBTASK_DESCRIPTION,
  ONBOARDING_FIRST_CLAW_SUBTASK_DESCRIPTION,
  ONBOARDING_FIRST_CONTRACT_SUBTASK_DESCRIPTION,
  ONBOARDING_READY_SUBTASK_DESCRIPTION,
} from '../../templates/messages/index.js';

import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { EnsureSupervision } from '../supervision-policy.js';
import { createDaemonSpawnOptions } from '../../daemon/index.js';
import { readOnboardingStatus, type OnboardingStatus } from '../../core/contract/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

// phase 1909 Step C（M13 扩）：子任务描述字面归 templates/messages 单源；
// id 集合、顺序与 language==='auto' 分支留在本 owner。
export function buildOnboardingSubtasks(language: string): Array<{ id: string; description: string }> {
  const langInstruction = language === 'auto'
    ? ONBOARDING_LANG_INSTRUCTION_AUTO
    : onboardingLangInstructionTyped(language);

  return [
    {
      id: 'language',
      description: onboardingLanguageSubtaskDescription(langInstruction),
    },
    {
      id: 'identity',
      description: ONBOARDING_IDENTITY_SUBTASK_DESCRIPTION,
    },
    {
      id: 'user',
      description: ONBOARDING_USER_SUBTASK_DESCRIPTION,
    },
    {
      id: 'soul',
      description: ONBOARDING_SOUL_SUBTASK_DESCRIPTION,
    },
    {
      id: 'first-claw',
      description: ONBOARDING_FIRST_CLAW_SUBTASK_DESCRIPTION,
    },
    {
      id: 'first-contract',
      description: ONBOARDING_FIRST_CONTRACT_SUBTASK_DESCRIPTION,
    },
    {
      id: 'ready',
      description: ONBOARDING_READY_SUBTASK_DESCRIPTION,
    },
  ];
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

/**
 * Atomic snapshot of initialization + onboarding state.
 * Merges two disk reads into a single synchronous call to eliminate
 * TOCTOU window between isInitialized() and getOnboardingStatus().
 */
export function getInitializationSnapshot(deps: StartCommandDeps & { audit?: AuditLog }, motionDir: string): {
  isInitialized: boolean;
  onboarding: OnboardingStatus;
} {
  return {
    isInitialized: deps.rootConfig.isInitialized(),
    onboarding: getOnboardingStatus(motionDir, deps),
  };
}

/**
 * Find the Onboarding contract and determine its completion state.
 * Wrapper around L4 readOnboardingStatus pure helper (static-phase path).
 */
export function getOnboardingStatus(motionDir: string, deps: { fsFactory: (baseDir: string) => FileSystem; audit?: AuditLog }): OnboardingStatus {
  return readOnboardingStatus(motionDir, deps);
}

/* LLM connection check & reconfigure helpers moved to ../llm-connection-check.ts (phase 1470). */

/**
 * phase 1280: start 运行时的显式依赖。
 * ensureSupervision 为必传的一次性监督 capability——由 CLI 监督边界
 * （cliDeferredRequiredAction）创建并注入；start 不直接 import Watchdog。
 */
interface StartCommandRuntime {
  audit?: AuditLog;
  ensureSupervision: EnsureSupervision;
}

interface StartCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'isInitialized' | 'loadGlobal' | 'saveGlobal' | 'patchPrimary'>;
}

export async function startCommand(deps: StartCommandDeps, runtime: StartCommandRuntime): Promise<void> {
  try {
    await _start(deps, runtime);
  } catch (error) {
    throw new CliError('chestnut start failed: ' + (formatErr(error)), { cause: error });
  }
}

async function _start(deps: StartCommandDeps, runtime: StartCommandRuntime): Promise<void> {
  const { audit } = runtime;
  // Step 1: workspace init
  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const snapshot = getInitializationSnapshot({ ...deps, audit }, motionDir);
  const wasFirstRun = !snapshot.isInitialized;
  if (wasFirstRun) {
    await initCommand(deps, true);
  }
  // phase 1280: workspace bootstrap（config 完整落盘）后才恢复 Watchdog；
  // 之后的 Motion init / daemon spawn / contract / chat 均位于监督之下。
  await runtime.ensureSupervision();
  // Step 2: motion init
  const notifyFs = deps.fsFactory(motionDir);
  const notifyAudit = actionAuditFor(motionDir, deps);
  // phase 1864 Step C（CT-D2）：发送归 Messaging；位置经拓扑 resolver 注入。
  // Motion-only callsite: motionDir = <chestnutRoot>/motion → dirname 一层即 chestnutRoot。
  const notifyChestnutRoot = makeChestnutRoot(path.dirname(motionDir));
  const clawNotifier = createClawNotifier({
    fs: notifyFs,
    audit: notifyAudit,
    resolveTarget: makeClawNotifyTargetResolver(notifyChestnutRoot),
  });
  // Phase 1464 Step B: spawn specification 归 Daemon 唯一 owner；motionSpawnOptions
  // 继续作为 supervision input（ensureRunning），只替换构造来源
  const motionSpawnOptions = createDaemonSpawnOptions({
    clawId: MOTION_CLAW_ID,
    agentDir: motionDir,
    workspaceRoot: getWorkspaceRoot(),
  });
  const motionFs = deps.fsFactory(motionDir);
  if (!motionFs.existsSync(CLAW_SPEC_FILE)) {
    await motionInitCommand(deps, true);
  }

  // Step 3: onboarding 状态
  const onboarding = snapshot.onboarding;

  // phase 1282 Step B: 所有分支统一经 ensureRunning 取得 ready Motion ——
  // 合法 winner（Watchdog / 并发 CLI）由 ProcessManager join 收敛到 ready，
  // start 不再组合 isAlive+spawn（TOCTOU）、不解释 ProcessSpawnConflictError。
  const pm = createProcessManagerForCLI({ ...deps, baseDir: getChestnutRoot() });
  const daemonReady = pm.ensureRunning(resolveClawDaemonDir(MOTION_CLAW_ID), motionSpawnOptions);

  // onboarding 已完成 → 直接进 chat
  if (onboarding.state === 'complete') {
    await daemonReady;
    await motionChatCommand(deps);
    return;
  }

  if (wasFirstRun && onboarding.state === 'not_found') {
    // ★ 首次运行：后台启动 daemon，前台展示语言选择（并行）
    daemonReady.catch((err: unknown) => {
      // 防止并行期间 UnhandledPromiseRejection；同时留 audit row 防 pickLanguage 异常导致 await daemonReady 永不达
      // 正常路径 line 412 `await daemonReady` 仍正确 rethrow → handleCliError 走规范路径
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      notifyAudit?.write(
        CLI_AUDIT_EVENTS.DAEMON_SPAWN_RACE_FAILED,
        `context=first_run_parallel_pickLanguage`,
        `error=${errMsg}`,
      );
    });

    const language = await pickLanguage();
    await daemonReady;

    // phase 1879 Step B: onboarding contract 的一次性 ContractSystem 装配归 Assembly
    // 窄 action context（motion 变体）——CLI 不再直构造；audit 由 context own、终态 dispose。
    // phase 1901 Step B: 注册 summon-verify policy（policy-only）；onboarding 无 task
    // identity，policy 首个无身份分支 pass-through，不写 claim。
    const action = await createMotionContractActionContext(deps, {
      registerSummonVerifyPolicy: true,
    });
    let contractId: string;
    try {
      contractId = await action.system.create({
        schema_version: 1,
        title: 'Onboarding',
        goal: 'Get to know the user and establish your identity before anything else. No interrogation — just talk.',
        subtasks: buildOnboardingSubtasks(language),
        verification: [],
      });
    } finally {
      action.dispose();
    }

    
    clawNotifier.notify(MOTION_CLAW_ID, {
      type: 'contract_created',
      source: 'system',
      priority: 'high',
      // phase 1909 Step B（M13）：正文呈现归 templates/messages 单源
      body: onboardingContractCreatedBody({ contractId }),
      idPrefix: 'start',
    });

  } else {
    // 非首次但 not_found（极少），或 in_progress
    await daemonReady;
    if (onboarding.state === 'not_found') {
      // phase 1901 Step B: 同首次运行分支，注册 summon-verify policy（policy-only）。
      const action = await createMotionContractActionContext(deps, {
        registerSummonVerifyPolicy: true,
      });
      let contractId: string;
      try {
        contractId = await action.system.create({
          schema_version: 1,
          title: 'Onboarding',
          goal: 'Get to know the user and establish your identity before anything else.',
          subtasks: buildOnboardingSubtasks('auto'),
          verification: [],
        });
      } finally {
        action.dispose();
      }
      clawNotifier.notify(MOTION_CLAW_ID, {
        type: 'contract_created', source: 'system', priority: 'high',
        // phase 1909 Step B（M13）：正文呈现归 templates/messages 单源
        body: onboardingContractCreatedBody({ contractId }),
        idPrefix: 'start',
      });
    } else {
      clawNotifier.notify(MOTION_CLAW_ID, {
        type: 'contract_resume', source: 'system', priority: 'high',
        // phase 1909 Step B（M13）：正文呈现归 templates/messages 单源；缺省分支留在本 owner
        body: onboardingContractResumedBody({
          // String() 保持与原模板字面插值逐字节一致（contractId 可选，原插值 undefined 同形渲染）
          contractId: String(onboarding.contractId),
          pendingSubtasks: onboarding.pending ?? [],
        }),
        idPrefix: 'start',
      });
    }
  }

  audit?.write(CLI_AUDIT_EVENTS.DAEMON_START);
  // Step 5: 打开 chat
  await motionChatCommand(deps);
}
