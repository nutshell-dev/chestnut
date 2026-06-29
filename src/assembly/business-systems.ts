import path from 'path';
import { formatErr } from '../foundation/node-utils/index.js';
import { resolveChestnutRoot } from '../core/claw-topology/index.js';
import { DISPATCH_SKILLS_PATH } from '../core/summon-system/dispatch-skills-paths.js';
import { makeClawId } from '../foundation/claw-identity/index.js';

import { createClawPermissionChecker } from '../core/permissions/claw-permissions.js';
import { TASKS_SYNC_EXEC_DIR } from '../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../foundation/file-tool/index.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../core/subagent/index.js';
import { TASKS_SYNC_SPAWN_DIR, createSpawnTool } from '../core/spawn-system/index.js';
import { TASKS_SYNC_SHADOW_DIR } from '../core/shadow-system/index.js';
import { InboxWriter, makeInboxPath, INBOX_PENDING_DIR } from '../foundation/messaging/index.js';
import { createAsyncTaskSystem } from '../core/async-task-system/index.js';
import type { AsyncTaskSystem } from '../core/async-task-system/system.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
} from '../core/async-task-system/dirs.js';
import { validateTaskShape } from '../core/async-task-system/task-corrupt-helpers.js';
import type { SubAgentTask, TaskId } from '../core/async-task-system/types.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import { summonContractExtractPostProcessor, SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME, AskMotionTool, createSummonVerifyPolicy, SummonTool } from '../core/summon-system/index.js';
import { createEvolutionSystem } from '../core/evolution-system/index.js';
import type { EvolutionSystem } from '../core/evolution-system/index.js';
import { createSubmitSubtaskTool } from '../core/contract/index.js';
import { createDoneTool } from '../core/subagent/index.js';
import { createStatusTool } from '../core/status-service/index.js';
import { composeStatusMotionGuidance } from './motion-guidance-composer.js';
import { createSkillTool } from '../foundation/skill-system/tools/skill.js';
import { CLAWS_DIR } from '../core/claw-topology/index.js';
import { createSendTool } from '../foundation/messaging/tools/send.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { createToolExecutor } from '../foundation/tools/index.js';
import type { IToolExecutor } from '../foundation/tools/index.js';
import { writePendingToolTaskFile } from '../core/async-task-system/index.js';
import { createDialogStore, DIALOG_DIR, CURRENT_DIALOG_FILE } from '../foundation/dialog-store/index.js';
import type { DialogStore } from '../foundation/dialog-store/index.js';
import { createInboxReader } from '../foundation/messaging/index.js';
import type { InboxReader } from '../foundation/messaging/index.js';
import { ContractAuditor } from '../core/contract/contract-auditor.js';
import { createMessageFormatterRegistry, registerMessagingFormatters } from '../foundation/messaging/index.js';
import { formatUserChat } from '../core/gateway/index.js';
import { registerWatchdogFormatters } from '../watchdog/inbox-formatter.js';
import { createHeartbeatInboxFormatter } from '../core/heartbeat/index.js';
import { registerContractFormatters } from '../core/contract/inbox-formatters.js';
import { registerAsyncTaskSystemFormatters } from '../core/async-task-system/inbox-formatter.js';
import { registerDaemonFormatters } from '../daemon/inbox-formatter.js';
import { registerMemoryFormatters } from '../core/memory/inbox-formatter.js';
import { createMotionGuidanceRegistry, registerAllMotionGuidance } from './guidance/index.js';
import type { MotionGuidanceRegistry, GuidanceEntry } from './guidance/index.js';
import type { MessageFormatterRegistry } from '../foundation/messaging/index.js';
import { createContractSystem } from '../core/contract/index.js';
import { createSystemAudit } from '../foundation/audit/index.js';
import { routeNotifyClaw as notifyClawFn } from '../core/claw-topology/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import type { CoreInfraOutput } from './core-infrastructure.js';
import type { ToolRegistry } from '../foundation/tools/index.js';

export interface BusinessSysInput {
  core: CoreInfraOutput;
}

export interface BusinessSysOutput {
  taskSystem: AsyncTaskSystem;
  evolutionSystem?: EvolutionSystem;
  permissionChecker: ReturnType<typeof createClawPermissionChecker>;
  selfInboxDir: string;
  selfInbox: ReturnType<typeof InboxWriter.__internal_create>;
  toolExecutor: IToolExecutor;
  /** Phase 773: shared base registry with plain sync exec (used by subagents). */
  baseToolRegistry: ToolRegistry;
  sessionManager: DialogStore;
  makeDialogStore: () => DialogStore;
  inboxReader: InboxReader;
  formatterRegistry: MessageFormatterRegistry;
  guidanceRegistry?: MotionGuidanceRegistry;
  guidanceCompose: (type: string, state: Record<string, string>) => GuidanceEntry | null;
}

/**
 * @module L6.Assembly.BusinessSystems
 * @layer L6 装配层
 * @consumers L6.Assembly.assemble
 *
 * Assemble 子工厂 — 步骤 9-11：AsyncTaskSystem → EvolutionSystem → DialogStore / InboxReader / FormatterRegistry / GuidanceRegistry。
 *
 * 抽出动机：assemble() M#1/SRP 治理（assembly-auditor §六.1 follow-up）。
 */
export async function createBusinessSystems(input: BusinessSysInput): Promise<BusinessSysOutput> {
  const { core } = input;
  const {
    fsFactory, systemFs, clawFs, clawDir, clawId, isMotion,
    auditWriter, llm, contractManager, toolRegistry, skillRegistry,
    toolTimeoutMs, maxConcurrent, outboxWriter, maxSteps,
  } = core;

  // A.6 selfInboxDir 提前到 taskSystem / callback 定义前（双链路保险 / cron job 注册块同步引用）
  const permissionChecker = createClawPermissionChecker({
    clawDir,
    strict: true,
    audit: auditWriter,
    fs: clawFs,
    taskSyncDirs: [
      TASKS_SYNC_EXEC_DIR,
      TASKS_SYNC_WRITE_DIR,
      TASKS_SYNC_SUBAGENT_DIR,
      TASKS_SYNC_SPAWN_DIR,
      TASKS_SYNC_SHADOW_DIR,
    ],
  });
  const selfInboxDir = path.join(clawDir, INBOX_PENDING_DIR);
  const selfInbox = InboxWriter.__internal_create(systemFs, makeInboxPath(selfInboxDir), auditWriter);

  // --- 9. AsyncTaskSystem（仅构造，不调 initialize / startDispatch；业务动作归 Runtime） ---
  let taskSystem: AsyncTaskSystem;
  try {
    taskSystem = createAsyncTaskSystem(clawDir, systemFs, {
      maxConcurrent,
      auditWriter,
      llm,
      contractManager,
      outboxWriter,
      registry: toolRegistry,
      toolTimeoutMs,
      permissionChecker,
      selfInbox,
      fsFactory,
      askMotionToolFactory: (llmArg, motionDialogStore) => new AskMotionTool(llmArg, motionDialogStore),
    });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=task_system`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: AsyncTaskSystem construct failed: ${formatErr(e)}`, { cause: e });
  }
  taskSystem.addPostProcessor(SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME, summonContractExtractPostProcessor);
  taskSystem.addPostProcessor('dispatch-contract-extract', summonContractExtractPostProcessor);

  // Phase 230 / phase 281 Step B: wire SummonVerifyPolicy into ContractSystem
  // 必须在 AsyncTaskSystem 构造完成后注册，以便 policy 通过 taskSystem 加载 task metadata。
  const summonVerifyPolicy = createSummonVerifyPolicy({
    auditWriter,
    loadTask: async (taskId: TaskId): Promise<SubAgentTask | undefined> => {
      for (const dir of [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR]) {
        try {
          const content = await systemFs.read(`${dir}/${taskId}.json`);
          const parsed = JSON.parse(content) as unknown;
          if (validateTaskShape(parsed) && (parsed as SubAgentTask).kind === 'subagent') {
            return parsed as SubAgentTask;
          }
        } catch (err) {
          if (isFileNotFound(err)) continue;
          throw err;
        }
      }
      return undefined;
    },
  });
  contractManager.registerCreatePolicy('summon-verify', summonVerifyPolicy);

  // --- 10. EvolutionSystem (motion only / phase411 Step B) ---
  let evolutionSystem: EvolutionSystem | undefined;
  if (isMotion) {
    try {
      evolutionSystem = createEvolutionSystem({
        fs: systemFs,
        audit: auditWriter,
        taskSystem,
        contractManager,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=evolution_system`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: EvolutionSystem construct failed: ${formatErr(e)}`, { cause: e });
    }
    if (evolutionSystem) {
      try {
        await evolutionSystem.init();
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=evolution_system`, `phase=init`, `reason=${formatErr(e)}`);
        throw new Error(`Assembly: EvolutionSystem.init failed: ${formatErr(e)}`, { cause: e });
      }

      const motionReviewContext = {
        motionFs: systemFs,
        motionBaseDir: clawDir,
        motionAudit: auditWriter,
        clawsBaseDir: path.join(
          resolveChestnutRoot(clawDir, true),
          CLAWS_DIR
        ),
        clawFsFactory: fsFactory,
        clawContractManagerFactory: (d: string, id: string, fs: typeof systemFs) => {
          const cr = resolveChestnutRoot(d, false);
          const perClawAudit = createSystemAudit(fs, d);
          return createContractSystem({
            clawDir: d,
            clawId: makeClawId(id),
            fs,
            audit: perClawAudit,
            toolRegistry,
            toolTimeoutMs,
            fsFactory,
            // phase 104: pre-bound notifyClaw
            notifyClaw: (targetClawId, message) =>
              notifyClawFn(fs, cr, MOTION_CLAW_ID, targetClawId, message, perClawAudit),
          });
        },
      };
      contractManager.onContractCompleted(async (contractId) => {
        if (!evolutionSystem) return;
        await evolutionSystem.runRetroForContract(contractId, motionReviewContext);
      });
    }
  }

  // --- 11. 工具注册 + toolExecutor + DialogStore + InboxReader + ContractAuditor + FormatterRegistry + GuidanceRegistry ---
  toolRegistry.register(createSubmitSubtaskTool(contractManager));
  toolRegistry.register(createDoneTool());
  toolRegistry.register(
    createStatusTool(contractManager, isMotion ? composeStatusMotionGuidance() : undefined),
  );
  toolRegistry.register(createSkillTool(skillRegistry, isMotion ? { dispatchSkillsDir: DISPATCH_SKILLS_PATH } : {}));
  toolRegistry.register(createSendTool(outboxWriter, MOTION_CLAW_ID));

  // phase 757: spawn/summon 工具改由 DI 注入 taskSystem，不再从 ExecContext 读取。
  // 注册放在 AsyncTaskSystem 构造完成后，确保 taskSystem 可用。
  toolRegistry.register(createSpawnTool({ taskSystem, originClawId: clawId, subagentMaxSteps: maxSteps }));
  toolRegistry.register(new SummonTool(taskSystem, clawId, maxSteps));

  let toolExecutor: IToolExecutor;
  try {
    toolExecutor = createToolExecutor(
      toolRegistry,
      toolTimeoutMs,
      (args) => writePendingToolTaskFile(clawFs, auditWriter, args),
    );
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=tool_executor`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: IToolExecutor construct failed: ${formatErr(e)}`, { cause: e });
  }

  const makeDialogStore = (): DialogStore =>
    createDialogStore(systemFs, DIALOG_DIR, auditWriter, CURRENT_DIALOG_FILE, clawId);

  let sessionManager: DialogStore;
  try {
    sessionManager = makeDialogStore();
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=session_manager`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: DialogStore construct failed: ${formatErr(e)}`, { cause: e });
  }

  taskSystem.setMainDialogStore(sessionManager);

  let inboxReader: InboxReader;
  try {
    inboxReader = createInboxReader(systemFs, auditWriter, 'inbox');
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=inbox_reader`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: InboxReader construct failed: ${formatErr(e)}`, { cause: e });
  }

  if (llm) {
    try {
      const clawInbox = InboxWriter.__internal_create(
        systemFs,
        makeInboxPath(path.join(clawDir, INBOX_PENDING_DIR)),
        auditWriter,
      );
      const auditor = new ContractAuditor({
        audit: auditWriter,
        fs: systemFs,
        inbox: clawInbox,
        llm,
        inboxPendingDir: INBOX_PENDING_DIR,
      });
      contractManager.attachAuditor(auditor);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_auditor`, `phase=construct`, `reason=${formatErr(e)}`);
    }
  }

  const formatterRegistry: MessageFormatterRegistry = createMessageFormatterRegistry();
  registerMessagingFormatters(formatterRegistry);
  formatterRegistry.register('user_chat', formatUserChat);
  registerWatchdogFormatters(formatterRegistry);
  registerContractFormatters(formatterRegistry);
  registerAsyncTaskSystemFormatters(formatterRegistry);
  registerDaemonFormatters(formatterRegistry);
  registerMemoryFormatters(formatterRegistry);
  if (isMotion) {
    formatterRegistry.register(
      'heartbeat',
      createHeartbeatInboxFormatter({ systemFs, audit: auditWriter }),
    );
  }

  let guidanceRegistry: MotionGuidanceRegistry | undefined;
  if (isMotion) {
    guidanceRegistry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(guidanceRegistry);
  }

  const guidanceCompose = (type: string, state: Record<string, string>) => guidanceRegistry?.compose(type, state) ?? null;

  return {
    taskSystem,
    evolutionSystem,
    permissionChecker,
    selfInboxDir,
    selfInbox,
    toolExecutor,
    baseToolRegistry: toolRegistry,
    sessionManager,
    makeDialogStore,
    inboxReader,
    formatterRegistry,
    guidanceRegistry,
    guidanceCompose,
  };
}
