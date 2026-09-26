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

import type { RootConfigAdmin, InitializationState } from '../../assembly/index.js';
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
import {
  resolveOnboardingIdentity,
  ONBOARDING_CONTRACT_ID,
  type OnboardingIdentityVerdict,
  type OnboardingStatus,
} from '../../core/contract/index.js';
import { ContractValidationError } from '../../core/contract/index.js';
import type { ContractYaml } from '../../core/contract/index.js';
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
  initialization: InitializationState;
  onboarding: OnboardingStatus;
} {
  // Phase 1911 Step D：typed 初始化状态（root YAML exists ≠ ready）；
  // isInitialized 布尔面保留给既有消费者，语义 = ready。
  const initialization = deps.rootConfig.getInitializationState();
  return {
    isInitialized: initialization === 'ready',
    initialization,
    onboarding: getOnboardingStatus(motionDir, deps),
  };
}

/**
 * Find the Onboarding contract and determine its completion state.
 *
 * Phase 1912 Step E（RACE-ONBOARDING-CROSS-ID，业务边界用户裁决）：start 门控
 * 消费 owner 身份裁决（resolveOnboardingIdentity），不再是 title 首个命中快照
 * （readOnboardingStatus）——title 是展示字段不是身份字段，随机 id 同名合同
 * 只是歧义迁移候选，不得冒充 start onboarding：
 * - absent → not_found（准 stable create）；
 * - unique → in_progress/complete（只有 stable id 身份可复用）；
 * - conflict → throw（歧义/损坏证据 fail-closed，留证不覆盖）。
 */
export function getOnboardingStatus(motionDir: string, deps: { fsFactory: (baseDir: string) => FileSystem; audit?: AuditLog }): OnboardingStatus {
  const verdict = resolveOnboardingIdentity(motionDir, deps);
  if (verdict.kind === 'absent') return { state: 'not_found' };
  if (verdict.kind === 'unique') {
    return verdict.state === 'complete'
      ? { state: 'complete' }
      : { state: 'in_progress', contractId: verdict.contractId, pending: verdict.pending };
  }
  throw onboardingIdentityConflictError(verdict);
}

/** conflict verdict → 统一错误文本（start 门控与 ensureOnboardingContract 共用）。 */
function onboardingIdentityConflictError(
  verdict: Extract<OnboardingIdentityVerdict, { kind: 'conflict' }>,
): Error {
  return new Error(
    `onboarding identity conflict: ${verdict.detail}; ` +
    `candidates=[${verdict.candidates.join(', ')}]; evidence preserved, not overwritten`,
  );
}

/**
 * Phase 1910 Step C（RACE-START-ONBOARDING-SINGLETON）：onboarding singleton
 * 创建 authority。业务唯一身份 = 稳定 contract id（ONBOARDING_CONTRACT_ID，
 * owner 定义于 core/contract）；创建权由 ContractSystem `.creating` O_EXCL
 * claim 裁决，CLI 不再从 not_found 快照直接派生随机 id 创建。
 *
 * - winner：正常创建，返回 created=true。
 * - 并发 loser / 崩溃重试（already_exists）：先等待 winner publish 窗口
 *   （有限重读），仍不可见则调 owner recoverCreation 完成 claim-only 崩溃的
 *   winner 提交；最终重读磁盘事实——读到则 created=false 转 resume，
 *   读不到则 fail-closed（保留证据，不覆盖、不再随机创建）。
 */
export async function ensureOnboardingContract(
  deps: StartCommandDeps,
  action: { system: Pick<ContractSystemLike, 'create' | 'recoverCreation'> },
  motionDir: string,
  contract: ContractYaml,
): Promise<{ contractId: string; created: boolean }> {
  // Phase 1911 Step I（RACE-ONBOARDING-LEGACY-ID-MIGRATION）：创建授权必须消费
  // owner 唯一性裁决——不用 title 扫描快照（首个命中即返回）授权 stable create。
  // Phase 1912 Step E：title 匹配降级为迁移候选/冲突检测；unique 只可能是
  // stable id 身份，随机 id 同名合同一律 conflict（停止自动采用）。
  const verdict = resolveOnboardingIdentity(motionDir, deps);
  if (verdict.kind === 'conflict') {
    throw onboardingIdentityConflictError(verdict);
  }
  if (verdict.kind === 'unique') {
    // 既有 stable 业务身份（含已完成 archive）→ 复用转 resume，不另建
    return { contractId: verdict.contractId, created: false };
  }

  try {
    const contractId = await action.system.create({
      ...contract,
      id: ONBOARDING_CONTRACT_ID,
    });
    return { contractId, created: true };
  } catch (err) {
    if (!(err instanceof ContractValidationError) || err.field !== 'id' || err.kind !== 'already_exists') {
      throw err;
    }
  }

  // loser：等待 winner 完成 publish（claim→publish 正常为毫秒级窗口）。
  // Phase 1912 Step E：重读经同一身份裁决（unique 只可能 stable；歧义 conflict
  // fail-closed），不用 title 快照——同名普通合同不得在窗口内被误认为 winner。
  const ONBOARDING_REREAD_ATTEMPTS = 20;
  const ONBOARDING_REREAD_DELAY_MS = 100;
  for (let attempt = 0; attempt < ONBOARDING_REREAD_ATTEMPTS; attempt++) {
    const reread = resolveOnboardingIdentity(motionDir, deps);
    if (reread.kind === 'unique') {
      return { contractId: reread.contractId, created: false };
    }
    if (reread.kind === 'conflict') {
      throw onboardingIdentityConflictError(reread);
    }
    await new Promise<void>(resolve => setTimeout(resolve, ONBOARDING_REREAD_DELAY_MS));
  }

  // winner 崩溃（claim-only）或不可读：经 owner 恢复后再裁决一次
  const recovered = await action.system.recoverCreation(ONBOARDING_CONTRACT_ID);
  const finalVerdict = resolveOnboardingIdentity(motionDir, deps);
  if (finalVerdict.kind === 'unique') {
    return { contractId: finalVerdict.contractId, created: false };
  }
  if (finalVerdict.kind === 'conflict') {
    throw onboardingIdentityConflictError(finalVerdict);
  }
  throw new Error(
    `onboarding creation indeterminate: claim for "${ONBOARDING_CONTRACT_ID}" exists ` +
    `but no readable onboarding contract (recovery=${recovered}); evidence preserved, not overwritten`,
  );
}

/** start 实际消费的 ContractSystem 窄面（便于测试替换）。 */
interface ContractSystemLike {
  create(contract: ContractYaml): Promise<string>;
  recoverCreation(contractId: string): Promise<'absent' | 'published' | 'recovered' | 'failed'>;
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
  rootConfig: Pick<RootConfigAdmin, 'isInitialized' | 'loadGlobal' | 'saveGlobal' | 'saveGlobalExclusive' | 'patchPrimary' | 'getInitializationState' | 'completeInitialization'>;
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
  const wasFirstRun = snapshot.initialization === 'absent';
  if (wasFirstRun) {
    await initCommand(deps, true);
  } else if (snapshot.initialization === 'in_progress') {
    // Phase 1911 Step D：崩溃窗口/legacy 无 marker —— 幂等恢复完整 bootstrap
    // 后继续，不消费 config-only 半成品状态。
    deps.rootConfig.completeInitialization();
  } else if (snapshot.initialization === 'invalid') {
    throw new CliError(
      'Workspace initialization state is invalid: root config or workspace layout ' +
      'is corrupted. Inspect .chestnut/ manually; start will not overwrite it.',
    );
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
    let onboardingResult: { contractId: string; created: boolean };
    try {
      onboardingResult = await ensureOnboardingContract(deps, action, motionDir, {
        schema_version: 1,
        title: 'Onboarding',
        goal: 'Get to know the user and establish your identity before anything else. No interrogation — just talk.',
        subtasks: buildOnboardingSubtasks(language),
        verification: [],
      });
    } finally {
      action.dispose();
    }

    // loser（并发 start 已创建/恢复 winner）不重复发 created 通知，转 resume
    if (onboardingResult.created) {
      clawNotifier.notify(MOTION_CLAW_ID, {
        type: 'contract_created',
        source: 'system',
        priority: 'high',
        // phase 1909 Step B（M13）：正文呈现归 templates/messages 单源
        body: onboardingContractCreatedBody({ contractId: onboardingResult.contractId }),
        idPrefix: 'start',
      });
    } else {
      const status = getOnboardingStatus(motionDir, deps);
      clawNotifier.notify(MOTION_CLAW_ID, {
        type: 'contract_resume', source: 'system', priority: 'high',
        body: onboardingContractResumedBody({
          contractId: String(onboardingResult.contractId),
          pendingSubtasks: status.pending ?? [],
        }),
        idPrefix: 'start',
      });
    }

  } else {
    // 非首次但 not_found（极少），或 in_progress
    await daemonReady;
    if (onboarding.state === 'not_found') {
      // phase 1901 Step B: 同首次运行分支，注册 summon-verify policy（policy-only）。
      const action = await createMotionContractActionContext(deps, {
        registerSummonVerifyPolicy: true,
      });
      let onboardingResult: { contractId: string; created: boolean };
      try {
        onboardingResult = await ensureOnboardingContract(deps, action, motionDir, {
          schema_version: 1,
          title: 'Onboarding',
          goal: 'Get to know the user and establish your identity before anything else.',
          subtasks: buildOnboardingSubtasks('auto'),
          verification: [],
        });
      } finally {
        action.dispose();
      }
      if (onboardingResult.created) {
        clawNotifier.notify(MOTION_CLAW_ID, {
          type: 'contract_created', source: 'system', priority: 'high',
          // phase 1909 Step B（M13）：正文呈现归 templates/messages 单源
          body: onboardingContractCreatedBody({ contractId: onboardingResult.contractId }),
          idPrefix: 'start',
        });
      } else {
        const status = getOnboardingStatus(motionDir, deps);
        clawNotifier.notify(MOTION_CLAW_ID, {
          type: 'contract_resume', source: 'system', priority: 'high',
          body: onboardingContractResumedBody({
            contractId: String(onboardingResult.contractId),
            pendingSubtasks: status.pending ?? [],
          }),
          idPrefix: 'start',
        });
      }
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
