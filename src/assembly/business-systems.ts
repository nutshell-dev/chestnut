import path from 'path';
import { formatErr } from '../foundation/node-utils/index.js';
import { resolveChestnutRoot } from '../foundation/claw-identity/index.js';
import { DISPATCH_SKILLS_PATH } from '../core/evolution-system/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';

import { createClawPermissionChecker } from '../core/permissions/index.js';
import { TASKS_SYNC_EXEC_DIR } from '../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../foundation/file-tool/index.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../core/subagent/index.js';
import { TASKS_SYNC_SPAWN_DIR, createSpawnTool } from '../core/spawn-system/index.js';
import { TASKS_SYNC_SHADOW_DIR, interpretShadowExecutorPayload } from '../core/shadow-system/index.js';
import { InboxWriter, makeInboxPath, INBOX_PENDING_DIR } from '../foundation/messaging/index.js';
import { createAsyncTaskSystem, createStandardDeliverySink } from '../core/async-task-system/index.js';
import { createSubagentTaskExecutor } from './subagent-task-executor.js';
import { PersistentShortIdIndex, type AsyncTaskSystem } from '../core/async-task-system/index.js';
// phase 1872 Step D: task 事实读取经 owner 窄查询（Assembly 不再直读 ATS 目录/schema）。
import { loadSubAgentTask } from '../core/async-task-system/index.js';
import {
  createSummonContractExtractPostProcessor,
  SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
  createSummonVerifyPolicy,
  createSummonCreationClaimStore,
  SummonTool,
  listPendingRetrospectives,
  ackPendingRetrospective,
} from '../core/summon-system/index.js';
import type { SummonContractQuery } from '../core/summon-system/index.js';
import { createEvolutionSystem } from '../core/evolution-system/index.js';
import type { EvolutionSystem, MotionReviewContext } from '../core/evolution-system/index.js';
import { makeContractId } from '../core/contract/index.js';

import { createDoneTool } from '../core/subagent/index.js';
import { createStatusTool } from '../core/status-service/index.js';
import { composeStatusMotionGuidance } from './motion-guidance-composer.js';
import { createSkillTool } from '../foundation/skill-system/index.js';
import { CLAWS_DIR } from '../foundation/claw-identity/index.js';
import { createSendTool } from '../foundation/messaging/index.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { createToolExecutor } from '../foundation/tools/index.js';
import type { IToolExecutor } from '../foundation/tools/index.js';
import { createDialogStore, DIALOG_DIR, CURRENT_DIALOG_FILE } from '../foundation/dialog-store/index.js';
import type { DialogStore } from '../foundation/dialog-store/index.js';
import { createInboxReader } from '../foundation/messaging/index.js';
import type { InboxReader } from '../foundation/messaging/index.js';
import {
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
  MESSAGING_INBOX_MESSAGE_TYPES,
} from '../foundation/messaging/index.js';
import { GATEWAY_INBOX_MESSAGE_TYPES } from '../core/gateway/index.js';
import { WATCHDOG_INBOX_MESSAGE_TYPES } from '../watchdog/index.js';
import { createHeartbeatInboxFormatter } from '../core/heartbeat/index.js';
import { CONTRACT_INBOX_MESSAGE_TYPES } from '../core/contract/index.js';
import { ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES } from '../core/async-task-system/index.js';
import { MEMORY_INBOX_MESSAGE_TYPES } from '../core/memory/index.js';
import { EVENTLOOP_INBOX_MESSAGE_TYPES } from '../core/event-loop/index.js';
import type { AssemblyContributions } from './types.js';
import { createMotionGuidanceRegistry, registerAllMotionGuidance } from './guidance/index.js';
import type { MotionGuidanceRegistry } from './guidance/index.js';
import type { GuidanceCompose } from '../core/runtime/index.js';
import type { InboxMessageTypeRegistry } from '../foundation/messaging/index.js';
import { createContractSystem, queryContractExistence } from '../core/contract/index.js';
import { createSystemAudit } from '../foundation/audit/index.js';
import { makeClawNotifyTargetResolver } from '../core/claw-topology/index.js';
import { createClawNotifier } from '../foundation/messaging/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import type { CoreInfraOutput } from './core-infrastructure.js';
import type { ToolRegistry } from '../foundation/tools/index.js';

interface BusinessSysInput {
  core: CoreInfraOutput;
  /** phase 1243 Step B: external production contributions（inbox message type declarations 等） */
  contributions?: AssemblyContributions;
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
  formatterRegistry: InboxMessageTypeRegistry;
  guidanceRegistry?: MotionGuidanceRegistry;
  /** phase 1256 Step A: 引用 Runtime callback port 单一 type-only export（禁双源手写签名） */
  guidanceCompose: GuidanceCompose;
  /** phase 821: 供 motion-addons 桥接 worker claw 契约完成 → evolution retro */
  motionReviewContext?: MotionReviewContext;
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
    toolTimeoutMs, maxConcurrent, outboxWriter, maxSteps, messagingLimits,
    streamWriter,
  } = core;
  const { contributions } = input;

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
  const selfInbox = InboxWriter.__internal_create(systemFs, makeInboxPath(selfInboxDir), auditWriter, messagingLimits);

  // --- 9. AsyncTaskSystem（仅构造，不调 initialize / startDispatch；业务动作归 Runtime） ---
  // phase 1863 (AT-D5)：执行/交付 adapter 在装配层构造（核心只持最小接口）
  const subagentTaskExecutor = createSubagentTaskExecutor({
    llm,
    registry: toolRegistry,
    toolTimeoutMs,
    permissionChecker,
    // phase 1863 (AT-D7)：executor payload 语义归 shadow owner——装配注入解释面
    executorPayloadAdapter: interpretShadowExecutorPayload,
  });
  const deliverySink = createStandardDeliverySink();
  // Phase 849: dual-key shortId ↔ fullId index
  const shortIdIndex = new PersistentShortIdIndex(systemFs);
  let taskSystem: AsyncTaskSystem;
  try {
    taskSystem = createAsyncTaskSystem(clawDir, systemFs, {
      maxConcurrent,
      auditWriter,
      registry: toolRegistry,
      selfInbox,
      fsFactory,
      shortIdIndex,
      // phase 1863 (AT-D5)：最小执行/交付面——业务装配收口于 adapter
      taskExecutor: subagentTaskExecutor,
      deliverySink,
      // phase 1872 Step F: parentStreamLog 构造参数一次固定（原
      // setParentStreamLog 构造后注入退役）；Phase 833 语义保持。
      parentStreamLog: streamWriter,
    });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=task_system`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: AsyncTaskSystem construct failed: ${formatErr(e)}`, { cause: e });
  }
  // --- 10. EvolutionSystem (motion only / phase411 Step B) ---
  let evolutionSystem: EvolutionSystem | undefined;
  let motionReviewContext: MotionReviewContext | undefined;
  if (isMotion) {
    // phase 1445 Step D（裁定②）：init(motionReviewContext) 内化进 createEvolutionSystem 工厂，
    // motionReviewContext 提前构造、经工厂参数传入；init 失败由工厂抛错、并入 construct catch。
    motionReviewContext = {
      motionFs: systemFs,
      motionBaseDir: clawDir,
      motionAudit: auditWriter,
      clawsBaseDir: path.join(
        resolveChestnutRoot(clawDir, true),
        CLAWS_DIR
      ),
      clawFsFactory: fsFactory,
      listLegacyPendingRetrospectives: () => listPendingRetrospectives({ fs: systemFs }),
      ackLegacyPendingRetrospective: (contractId) =>
        ackPendingRetrospective({ fs: systemFs, contractId, audit: auditWriter }),
      clawContractManagerFactory: async (d: string, id: string, fs: typeof systemFs) => {
        const cr = resolveChestnutRoot(d, false);
        const perClawAudit = createSystemAudit(fs, d);
        // phase 1864 Step C（CT-D2）：发送归 Messaging；位置经拓扑 resolver 注入。
        const clawNotifier = createClawNotifier({
          fs,
          audit: perClawAudit,
          resolveTarget: makeClawNotifyTargetResolver(cr),
        });
        // phase 1445 Step D：旁路 per-claw 实例故意不传 bootReconcile（不 init、只读用途）
        return createContractSystem({
          clawDir: d,
          clawId: makeClawId(id),
          fs,
          audit: perClawAudit,
          toolRegistry,
          toolTimeoutMs,
          fsFactory,
          // phase 104: pre-bound notifyClaw
          notifyClaw: (targetClawId, message) => clawNotifier.notify(targetClawId, message),
        });
      },
    };
    try {
      evolutionSystem = await createEvolutionSystem({
        fs: systemFs,
        audit: auditWriter,
        taskSystem,
        contractManager,
        motionReviewContext,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=evolution_system`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: EvolutionSystem construct failed: ${formatErr(e)}`, { cause: e });
    }
  }


  // Phase 230 / phase 281 Step B: wire SummonVerifyPolicy into ContractSystem
  // 必须在 AsyncTaskSystem 构造完成后注册，以便 policy 通过 taskSystem 加载 task metadata。
  // Phase 1396 Step B: SummonSystem 独占的 0/1 创建 claim store（workspace 级
  // `.chestnut/summons/<summonId>/creation-claim.json`），daemon 与 CLI 经同一 factory 注入。
  const chestnutRoot = resolveChestnutRoot(clawDir, isMotion);
  const summonClaimStore = createSummonCreationClaimStore({ fs: fsFactory(chestnutRoot) });
  const summonVerifyPolicy = createSummonVerifyPolicy({
    auditWriter,
    claimStore: summonClaimStore,
    // phase 1872 Step D: 目录口径/扫描顺序/schema 校验归 ATS owner（语义与迁移前等价）。
    loadTask: (taskId) => loadSubAgentTask(systemFs, taskId),
  });
  contractManager.registerCreatePolicy('summon-verify', summonVerifyPolicy);

  if (isMotion && evolutionSystem) {
    // Phase 1396 Step B: summon 创建事实查询 capability —— 核实 claim 指向的
    // contract 是否已提交（active 或 archive）。
    // phase 1872 Step E: 改消费 ContractSystem owner 窄查询（0-instance-dep，同
    // hasContract 语义）——不再为每次查询构造 audit/notifier/完整 ContractSystem。
    const summonContractQuery: SummonContractQuery = {
      async exists(targetExecutorId: string, contractId: string): Promise<boolean> {
        const execDir = path.join(chestnutRoot, CLAWS_DIR, targetExecutorId);
        const execFs = fsFactory(execDir);
        return queryContractExistence(execFs, makeContractId(contractId));
      },
    };
    // Phase 1396 Step M: summon post-processor 只注入 claimStore + contractQuery；
    // contract 创建事实确认即 SummonSystem 终点，retrospective 由 ContractObserver→Evolution 链路 own。
    const summonContractExtractPostProcessor = createSummonContractExtractPostProcessor(
      { claimStore: summonClaimStore, contractQuery: summonContractQuery },
    );
    taskSystem.addPostProcessor(SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME, summonContractExtractPostProcessor);
    taskSystem.addPostProcessor('dispatch-contract-extract', summonContractExtractPostProcessor);

    // Phase 1396 Step M：retrospective 完成事实交付统一由 ContractObserver（archive 扫描 +
    // retrospective 专用水位，at-least-once）→ EvolutionSystem.observeContractCompleted 承担；
    // 不再订阅 ContractManager 的进程内 onContractCompleted，避免双 producer。
    // phase 1445 Step D：evolutionSystem.init(motionReviewContext) 已内化进 createEvolutionSystem 工厂。
  }

  // --- 11. 工具注册 + toolExecutor + DialogStore + InboxReader + ContractAuditor + FormatterRegistry + GuidanceRegistry ---
  toolRegistry.register(contractManager.createSubmitSubtaskTool());
  toolRegistry.register(createDoneTool());
  toolRegistry.register(
    createStatusTool(contractManager, isMotion ? composeStatusMotionGuidance() : undefined),
  );
  toolRegistry.register(createSkillTool(skillRegistry, isMotion ? { dispatchSkillsDir: DISPATCH_SKILLS_PATH } : {}));
  toolRegistry.register(createSendTool(outboxWriter, MOTION_CLAW_ID));

  // phase 757: spawn/summon 工具改由 DI 注入 taskSystem，不再从 ExecContext 读取。
  // 注册放在 AsyncTaskSystem 构造完成后，确保 taskSystem 可用。
  toolRegistry.register(createSpawnTool({ taskSystem, originClawId: clawId, subagentMaxSteps: maxSteps }));
  toolRegistry.register(new SummonTool({ scheduler: taskSystem, correlation: { originClawId: clawId } }));

  let toolExecutor: IToolExecutor;
  try {
    toolExecutor = createToolExecutor(toolRegistry, toolTimeoutMs);
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


  let inboxReader: InboxReader;
  try {
    inboxReader = createInboxReader(systemFs, auditWriter, 'inbox');
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=inbox_reader`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: InboxReader construct failed: ${formatErr(e)}`, { cause: e });
  }

  // phase 1872 Step F: ContractAuditor 构造迁移至 core-infrastructure（owner 工厂
  // 构造参数一次固定，attachAuditor setter 退役）——本文件不再构造/后补。

  const formatterRegistry: InboxMessageTypeRegistry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(formatterRegistry, MESSAGING_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, GATEWAY_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, WATCHDOG_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, CONTRACT_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, MEMORY_INBOX_MESSAGE_TYPES);
  registerInboxMessageTypes(formatterRegistry, EVENTLOOP_INBOX_MESSAGE_TYPES);  // phase 1869 Step H
  // phase 1243 Step B: Daemon 等外部 lifecycle caller 的 declarations 由 contributions 传入。
  registerInboxMessageTypes(formatterRegistry, contributions?.inboxMessageTypes ?? []);
  if (isMotion) {
    formatterRegistry.register({
      type: 'heartbeat',
      owner: 'motion-heartbeat',
      rendering: {
        kind: 'custom',
        formatter: createHeartbeatInboxFormatter({ systemFs, audit: auditWriter }),
      },
    });
  }

  let guidanceRegistry: MotionGuidanceRegistry | undefined;
  if (isMotion) {
    guidanceRegistry = createMotionGuidanceRegistry();
    registerAllMotionGuidance(guidanceRegistry);
  }

  // phase 1256 Step B: envelope 原样透传 registry（Step A 中间解包已删）
  const guidanceCompose: GuidanceCompose = input => guidanceRegistry?.compose(input) ?? null;

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
    motionReviewContext,
  };
}
