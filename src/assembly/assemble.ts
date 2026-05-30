import path from 'path';

import type { FileSystem } from '../foundation/fs/types.js';

import { createAuditWriter, createSystemAudit, type AuditLog } from '../foundation/audit/index.js';
import { reconcileFallbackDumps } from '../foundation/audit/index.js';
import { createSnapshot } from '../foundation/snapshot/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from './snapshot-patterns.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import { createStreamWriter } from '../foundation/stream/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import { isFileNotFound } from '../foundation/fs/types.js';
import { NodeFileSystem } from '../foundation/fs/node-fs.js';

import { createAgentProcessManager } from '../foundation/process-manager/agent-factory.js';
import { type Runtime, type RuntimeDependencies } from '../core/runtime/index.js';
import { createRuntime } from '../core/runtime/index.js';
import { createLLMOrchestrator, type LLMOrchestrator, DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../foundation/llm-orchestrator/index.js';
import { createLLMAuditSink } from './llm-audit-sink.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import { CLAWS_DIR, DISPATCH_SKILLS_PATH } from '../foundation/paths.js';
import { createToolRegistry, type ToolRegistry } from '../foundation/tools/index.js';
import { createToolExecutor } from '../foundation/tools/index.js';
import type { IToolExecutor } from '../foundation/tools/index.js';
import { writePendingToolTaskFile } from '../core/async-task-system/index.js';
import { createSkillSystem, SkillSystem } from '../foundation/skill-system/index.js';
import { SKILLS_DIR_DEFAULT } from '../foundation/skill-system/index.js';
import { ContractSystem, createContractSystem } from '../core/contract/index.js';
import { ContractAuditor } from '../core/contract/contract-auditor.js';
import { createEvolutionSystem } from '../core/evolution-system/index.js';
import type { EvolutionSystem } from '../core/evolution-system/index.js';

import { createAsyncTaskSystem } from '../core/async-task-system/index.js';
import type { AsyncTaskSystem } from '../core/async-task-system/system.js';
import { summonContractExtractPostProcessor, AskMotionTool } from '../core/summon-system/index.js';

import { createFileTools, TASKS_SYNC_WRITE_DIR } from '../foundation/file-tool/index.js';
import { createCommandTools, TASKS_SYNC_EXEC_DIR } from '../foundation/command-tool/index.js';
import { createClawPermissionChecker } from '../core/permissions/claw-permissions.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../core/subagent/index.js';
import { TASKS_SYNC_SPAWN_DIR } from '../core/spawn-system/index.js';
import { TASKS_SYNC_SHADOW_DIR } from '../core/shadow-system/index.js';
import { CRON_TICK_INTERVAL_MS } from '../core/cron/constants.js';
import { DEFAULT_DISK_WARNING_MB } from '../watchdog/constants.js';
import { spawnTool } from '../core/spawn-system/index.js';
import { SummonTool } from '../core/summon-system/index.js';
import { createShadowTool } from '../core/shadow-system/index.js';
import { cleanupOrphanedTemp } from './cleanup.js';
import { createInboxReader, createOutboxWriter, notifyInbox, notifyClaw, InboxWriter, createMessaging, makeInboxPath } from '../foundation/messaging/index.js';
// phase 1414: formatter registry + Messaging 自家通用 formatter
import { createMessageFormatterRegistry, registerMessagingFormatters } from '../foundation/messaging/index.js';
// phase 1469: motion guidance registry (motion-only / claw 不装)
import { createMotionGuidanceRegistry, registerAllMotionGuidance } from './guidance/index.js';
import type { MotionGuidanceRegistry } from './guidance/index.js';
import type { MessageFormatterRegistry } from '../foundation/messaging/index.js';
// phase 1414: 业主自家 inbox-formatter
// phase 1419: 4 业主补注 sister（contract / daemon / memory / watchdog inactivity）+ Watchdog 切 register helper 形态
import { registerWatchdogFormatters } from '../watchdog/inbox-formatter.js';
import { formatUserChat } from '../core/gateway/index.js';
import { createHeartbeatInboxFormatter } from '../core/heartbeat/index.js';
import { registerContractFormatters } from '../core/contract/inbox-formatters.js';
import { registerDaemonFormatters } from '../daemon/inbox-formatter.js';
import { registerMemoryFormatters } from '../core/memory/inbox-formatter.js';
import type { Messaging } from '../foundation/messaging/index.js';
import { createSubmitSubtaskTool } from '../core/contract/index.js';
import { createDoneTool } from '../core/subagent/index.js';
import { createStatusTool } from '../core/status-service/index.js';
import { createSkillTool } from '../foundation/skill-system/tools/skill.js';
import { createSendTool } from '../foundation/messaging/tools/send.js';
import { createNotifyClawTool } from '../foundation/messaging/tools/notify-claw.js';
import { createDialogStore } from '../foundation/dialog-store/index.js';
import type { InboxReader } from '../foundation/messaging/index.js';
import type { OutboxWriter } from '../foundation/messaging/index.js';
import type { DialogStore } from '../foundation/dialog-store/index.js';

import { createHeartbeat, type Heartbeat } from '../core/runtime/index.js';
import { createCronRunner, parseSchedule, CronRunner } from '../core/cron/index.js';
import { runDiskMonitor } from '../core/cron/jobs/disk-monitor.js';
import { runLlmStats } from '../core/cron/jobs/llm-stats.js';
import { runMetricsSnapshot } from '../core/cron/jobs/metrics-snapshot.js';
import { runGitGcWeekly } from '../core/cron/jobs/git-gc-weekly.js';
import { runRetentionCleanup } from '../core/cron/jobs/retention-cleanup.js';
import { runAuditSizeMonitor } from '../core/cron/jobs/audit-size-monitor.js';
import { runSunsetMonitor } from '../core/cron/jobs/sunset-monitor.js';
import { createMemorySystem, memorySearchTool } from '../core/memory/index.js';
import type { MemorySystem } from '../core/memory/index.js';
import { runContractObserver } from '../core/contract/jobs/contract-observer.js';
import { runOutboxDrain, DEFAULT_LIMIT_PER_CLAW as OUTBOX_DRAIN_DEFAULT_LIMIT } from '../core/cron/jobs/outbox-drain.js';
import { DISK_MONITOR_CRON_TIMEOUT_MS } from '../core/cron/jobs/disk-monitor.js';
import { LLM_STATS_CRON_TIMEOUT_MS } from '../core/cron/jobs/llm-stats.js';
import { METRICS_SNAPSHOT_CRON_TIMEOUT_MS } from '../core/cron/jobs/metrics-snapshot.js';
import { CONTRACT_OBSERVER_CRON_TIMEOUT_MS } from '../core/contract/jobs/contract-observer.js';
import { GIT_GC_WEEKLY_CRON_TIMEOUT_MS } from '../core/cron/jobs/git-gc-weekly.js';
import { RETENTION_CLEANUP_CRON_TIMEOUT_MS } from '../core/cron/jobs/retention-cleanup.js';
import { AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS } from '../core/cron/jobs/audit-size-monitor.js';
import { SUNSET_MONITOR_CRON_TIMEOUT_MS } from '../core/cron/jobs/sunset-monitor.js';
import { OUTBOX_DRAIN_CRON_TIMEOUT_MS } from '../core/cron/jobs/outbox-drain.js';
import { buildLLMConfig } from '../foundation/config/index.js';
import { DEFAULT_MAX_CONCURRENT_TASKS } from '../core/async-task-system/constants.js';
import { DEFAULT_MAX_STEPS } from '../core/agent-executor/index.js';

import type { AssembleConfig, Instances } from './types.js';
import { createGateway } from '../core/gateway/index.js';
import type { Gateway } from '../core/gateway/index.js';
import { createAskUserTool } from '../core/gateway/index.js';
import { createStreamReader, STREAM_FILE, findRecentTurnStartOffset } from '../foundation/stream/index.js';
import { TASKS_SYNC_DIR } from '../core/async-task-system/index.js';
import { DIALOG_DIR } from '../foundation/dialog-store/dirs.js';
import { makeClawId, type ClawId, resolveClawforumRoot, type ClawDir, makeClawDir } from '../foundation/identity/index.js';
import type { ContractId } from '../foundation/identity/index.js';
import { MOTION_CLAW_ID } from '../constants.js';


/**
 * dream-trigger 是 assembly 装配 memorySystem capability 的 cron wrapper、
 * 无 dedicated cron job module (handler 1 行 inline memorySystem 直调).
 * 故 timeout const inline at assembly natural owner、显式标 ML#2/#3 例外.
 */
const DREAM_TRIGGER_CRON_TIMEOUT_MS = 30 * 60_000;  // 30 min

// 内部 helper（从 daemon.ts L42-75 搬入）
export function detectUncleanExit(_auditDir: string, auditWriter: AuditLog, fs: FileSystem): void {
  if (!fs.existsSync('audit.tsv')) return;
  try {
    const stat = fs.statSync('audit.tsv');
    if (stat.size === 0) return;
    const chunkSize = 4096;
    const offset = Math.max(0, stat.size - chunkSize);
    const buf = fs.readBytesSync('audit.tsv', offset, stat.size);
    const chunk = buf.toString('utf-8');
      const lastLine = chunk.split('\n').filter(Boolean).at(-1) ?? '';
      const type = lastLine.split('\t')[1];
      if (
        type === 'daemon_stop' ||
        type === 'daemon_unclean_exit' ||
        type === 'daemon_crash'
      ) return;
      const lastTs = lastLine.split('\t')[0] ?? new Date().toISOString();
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_UNCLEAN_EXIT, `last_ts=${lastTs}`);
  } catch (err: unknown) {
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(err)) {
      const code = (err as { code?: string })?.code;
      const message = err instanceof Error ? err.message : String(err);
      auditWriter.write(
        ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
        `module=detect_unclean_exit`,
        `phase=detect`,
        `reason=${code || message}`,
      );
    }
  }
}

// phase 1382 audit-trail B-2 REFRAMED note: detectUncleanExit (above) returns void early on no-op
// (file 0/empty/clean-stop) — NOT error path. assemble (below) throws on validation failure (real error).
// Two functions = two patterns by-design; audit B-2 framing「throw + return error model mix」reframe-out.
export async function assemble(config: AssembleConfig): Promise<Instances> {
  const { identity, clawId, clawDir, globalConfig, clawConfig } = config;
  if (identity === 'claw' && !clawConfig) {
    throw new Error('clawConfig is required when identity=claw');
  }
  const isMotion = identity === 'motion';
  const auditMaxSizeMb = globalConfig.audit?.retention?.max_size_mb ?? null;

  // phase155A + B + C 联合约定：system 组件无权限校验；工具层强制权限校验
  // systemFs: used by AuditWriter / Snapshot / DialogStore / Skill/Contract/Outbox/Inbox/Task/Context/Stream
  const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });
  const systemFs = fsFactory(clawDir);
  // clawFs: used by tools via ExecContextImpl.fs
  // phase430: PermissionChecker removed from NodeFileSystem ctor;
  // claw-space boundary is enforced by L4 caller (tools) autonomy.
  const clawFs = fsFactory(clawDir);
  const parentFs = fsFactory(path.join(clawDir, '..'));

  // syncDir = clawDir/tasks/sync (装配-level 共享 dir / 应然 §A.7)
  const syncDir = path.join(clawDir, TASKS_SYNC_DIR);
  await clawFs.ensureDir(syncDir);

  // --- 1. AuditWriter (daemon.ts L100-104) ---
  let auditWriter: AuditLog;
  try {
    auditWriter = createAuditWriter(systemFs, 'audit.tsv', auditMaxSizeMb);
  } catch (e) {
    throw new Error(`Assembly: audit writer construct failed: ${errMsg(e)}`, { cause: e });
  }

  // Reconcile prior crash fallback dumps after audit writer is ready
  try {
    await reconcileFallbackDumps(systemFs);
  } catch (err) {
    auditWriter.write(
      ASSEMBLY_AUDIT_EVENTS.FALLBACK_RECONCILE_FAILED,
      `reason=${errMsg(err)}`,
    );
  }

  // --- 2. ProcessManager + acquireLock (daemon.ts L107-108) ---
  let processManager: ProcessManager;
  try {
    processManager = createAgentProcessManager({ fsFactory }, auditWriter);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=process_manager`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ProcessManager construct failed: ${errMsg(e)}`, { cause: e });
  }

  let lockAcquired = false;
  try {
    processManager.acquireLock(clawId);
    lockAcquired = true;
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_LOCK_CONFLICT, `clawId=${clawId}`);
    throw e;
  }

  let llm: LLMOrchestrator | undefined;
  let streamWriter: StreamWriter | undefined;
  // Phase 1200: contractSystemCache dispose hook (motion lifecycle end-of-life)
  let disposeContractSystems: (() => Promise<void>) | undefined;

  try {
    // --- 3. Runtime (daemon.ts L111-137) ---
    let llmConfig: ReturnType<typeof buildLLMConfig>;
    try {
      llmConfig = isMotion
        ? buildLLMConfig(globalConfig)
        : buildLLMConfig(globalConfig, clawConfig!);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=llm_config`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: buildLLMConfig failed: ${errMsg(e)}`, { cause: e });
    }

    // --- L3-L5: 派生配置统一求值（motion vs claw 分叉） ---
    const globalDefaultMaxSteps = globalConfig.default_max_steps ?? DEFAULT_MAX_STEPS;
    const maxSteps = isMotion
      ? (globalConfig.motion?.max_steps ?? globalDefaultMaxSteps)
      : (clawConfig!.max_steps ?? globalDefaultMaxSteps);
    const maxConcurrent = isMotion
      ? (globalConfig.motion?.max_concurrent_tasks ?? DEFAULT_MAX_CONCURRENT_TASKS)
      : (clawConfig!.max_concurrent_tasks ?? DEFAULT_MAX_CONCURRENT_TASKS);
    const toolProfile = isMotion ? 'full' : clawConfig!.tool_profile;
    const toolTimeoutMs = globalConfig.tool_timeout_ms;
    const idleTimeoutMs = globalConfig.motion?.llm_idle_timeout_ms ?? DEFAULT_LLM_IDLE_TIMEOUT_MS;

    // --- L3-L5: llm ---
    try {
      llm = createLLMOrchestrator({ ...llmConfig, events: createLLMAuditSink(auditWriter) });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=llm`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: LLMOrchestrator construct failed: ${errMsg(e)}`, { cause: e });
    }

    // --- L3-L5: toolRegistry（空；SummonTool 留给 Runtime） ---
    let toolRegistry: ToolRegistry;
    try {
      toolRegistry = createToolRegistry();

      // phase428 FileTool 抽出 → foundation/file-tool/ / Assembly 显式注册
      // phase1006: permissionChecker 改由 ExecContext 注入，createFileTools 无需 factory
      for (const tool of createFileTools()) {
        toolRegistry.register(tool);
      }

      toolRegistry.register(spawnTool);
      // shadowTool 改为 post-runtime 注册（需要 Runtime.getTurnSnapshot）

      // phase 1406: SummonTool 走标准注册路径（构造期 0 参 / accessesCaller=true /
      // shadow path 通过 ExecContext.getCallerSnapshot() 读 caller 深度态、
      // mining path 用 ctx.registry 取 miner profile 工具）。不再走 Runtime
      // initialize() 内反向 import + new + register「结构性循环依赖妥协」。
      toolRegistry.register(new SummonTool());

      // phase378 后 exec 业务归 CommandTool L2 / 不再经 registerBuiltinTools / Assembly 显式注册
      const commandTools = createCommandTools();
      toolRegistry.register(commandTools.exec);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=tool_registry`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: ToolRegistry construct failed: ${errMsg(e)}`, { cause: e });
    }

    // --- L3-L5: skillRegistry (lazy init / phase 1053 α-6) ---
    let skillRegistry: SkillSystem;
    try {
      skillRegistry = createSkillSystem(systemFs, SKILLS_DIR_DEFAULT, auditWriter);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=skill_registry`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: SkillSystem construct failed: ${errMsg(e)}`, { cause: e });
    }

    // --- L3-L5: contractManager ---
    let contractManager: ContractSystem;
    try {
      contractManager = createContractSystem({
        clawDir, clawId, fs: systemFs, audit: auditWriter, llm,
        toolRegistry,   // phase 704: toolRegistry 注入 ContractSystem
        toolTimeoutMs,  // phase 1029 / F-2
        fsFactory,
        clawforumRoot: resolveClawforumRoot(clawDir, isMotion),  // phase 1406: 单一 truth source
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_manager`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: ContractSystem construct failed: ${errMsg(e)}`, { cause: e });
    }
    try {
      await contractManager.init();
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_manager`, `phase=init`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: ContractSystem.init failed: ${errMsg(e)}`, { cause: e });
    }

    // --- L2: outboxWriter ---
    let outboxWriter: OutboxWriter;
    try {
      outboxWriter = createOutboxWriter(clawId, clawDir, systemFs, auditWriter);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=outbox_writer`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: OutboxWriter construct failed: ${errMsg(e)}`, { cause: e });
    }

    // A.6 motionInboxDir 提前到 taskSystem / callback 定义前（双链路保险 / cron job 注册块同步引用）
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
    const motionInboxDir = path.join(clawDir, 'inbox', 'pending');
    const motionInbox = InboxWriter.__internal_create(systemFs, makeInboxPath(motionInboxDir), auditWriter);

    // --- L3-L5: taskSystem（仅构造，不调 initialize / startDispatch；业务动作归 Runtime） ---
    let taskSystem: AsyncTaskSystem;
    try {
      taskSystem = createAsyncTaskSystem(clawDir, systemFs, {
        maxConcurrent,
        auditWriter,
        llm,
        contractManager,
        outboxWriter,
        registry: toolRegistry,     // NEW: 装配好的 registry 注入 AsyncTaskSystem / 子代理共用
        toolTimeoutMs,              // phase 1029 / F-2
        permissionChecker,          // NEW: permission checker for subagent file tools
        motionInbox,
        fsFactory,
        clawforumRoot: resolveClawforumRoot(clawDir, isMotion),  // phase 1406: 单一 truth source
        askMotionToolFactory: (llm, motionDialogStore) => new AskMotionTool(llm, motionDialogStore),
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=task_system`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: AsyncTaskSystem construct failed: ${errMsg(e)}`, { cause: e });
    }
    // phase438: 注册 PostProcessors（装配期）
    taskSystem.addPostProcessor('summon-contract-extract', summonContractExtractPostProcessor);
    // backwards-compat (phase 1142 dispatch→summon migrate): 既有 pending tasks/queues/pending/<id>.json 内 `postProcessor: 'dispatch-contract-extract'` 仍认
    // SUNSET (per phase 1180 r129 E fork sunset SOP): 30 天 audit 0 触发 LEGACY_POST_PROCESSOR_INVOKED → r130+ phase 删本 fallback + subagent-helpers.ts:52 sibling
    taskSystem.addPostProcessor('dispatch-contract-extract', summonContractExtractPostProcessor);

    // NOTE: taskSystem.initialize() / startDispatch() 属 AsyncTaskSystem 业务语义，由 Runtime.initialize() 调用
    //       参见 接口冻结.md §4 "业务动作归属" + 原则 #2

    // --- L3-L5: EvolutionSystem (motion only / phase411 Step B) ---
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
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=evolution_system`, `phase=construct`, `reason=${errMsg(e)}`);
        throw new Error(`Assembly: EvolutionSystem construct failed: ${errMsg(e)}`, { cause: e });
      }
      if (evolutionSystem) {
        try {
          await evolutionSystem.init();
        } catch (e) {
          auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=evolution_system`, `phase=init`, `reason=${errMsg(e)}`);
          throw new Error(`Assembly: EvolutionSystem.init failed: ${errMsg(e)}`, { cause: e });
        }

        // Wire ContractSystem.contract_completed → EvolutionSystem.runRetroForContract
        const motionReviewContext = {
          motionFs: systemFs,
          motionBaseDir: clawDir,
          motionAudit: auditWriter,
          clawsBaseDir: path.join(
            resolveClawforumRoot(clawDir, true),  // phase 1406: motion-only context (guarded by if isMotion)
            CLAWS_DIR
          ),
          clawFsFactory: fsFactory,
          clawContractManagerFactory: (d: ClawDir, id: string, fs: FileSystem) => createContractSystem({ clawDir: d, clawId: makeClawId(id), fs, audit: createSystemAudit(fs, d), toolRegistry, toolTimeoutMs, fsFactory, clawforumRoot: resolveClawforumRoot(d, /* isMotion */ false) }),
        };
        contractManager.onContractCompleted(async (contractId) => {
          if (!evolutionSystem) return; // P1.NPE guard (phase 620 / mirror phase 607 dream-trigger)
          await evolutionSystem.runRetroForContract(contractId, motionReviewContext);
        });
      }
    }

    // 注入工具属性（避免通过 ExecContext 传业务依赖）
    // done 注册：phase360 后 done 业务归 ContractSystem / 不再经 registerBuiltinTools / Assembly 显式注册
    toolRegistry.register(createSubmitSubtaskTool(contractManager));
    toolRegistry.register(createDoneTool());                    // phase 765: 通用 done 工具（shadow / spawn 子代理 result 提交）
    toolRegistry.register(createStatusTool(contractManager));   // phase 446: builtins/index.ts 不再 register / Assembly 显式（同 phase 440 send + phase 442 skill 模板）

    // skill 注册：phase442 后 skill 业务归 SkillSystem / 不再经 registerBuiltinTools / Assembly 显式注册
    // Motion 注入 dispatchSkillsDir（dispatch 模板池 own / DISPATCH_SKILLS_PATH 物理路径不上 LLM 表面）；
    // 其他 claw 不传 = scope='dispatch' 运行期 reject（Motion→claw 单向访问原则）。
    toolRegistry.register(createSkillTool(skillRegistry, isMotion ? { dispatchSkillsDir: DISPATCH_SKILLS_PATH } : {}));

    // send 注册：phase440 后 send 业务归 Messaging / 不再经 registerBuiltinTools / Assembly 显式注册
    toolRegistry.register(createSendTool(outboxWriter));

    // --- L3-L5: toolExecutor ---
    let toolExecutor: IToolExecutor;
    try {
      toolExecutor = createToolExecutor(
        toolRegistry,
        toolTimeoutMs,
        (args) => writePendingToolTaskFile(clawFs, auditWriter, args),
      );
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=tool_executor`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: IToolExecutor construct failed: ${errMsg(e)}`, { cause: e });
    }

    // NOTE: 此段 L2 装配位于 L3-L5 之后，是 phase155C squash-merge 时为避免大规模代码移动保留的形态。
    // 语义正确（变量作用域覆盖全函数，依赖链仍 DAG），但与 phase155B 原拓扑"L2 先于 L3-L5"不一致。
    // 如要对齐拓扑走独立 phase 处理，见 coding plan/phase155/phase155C/fixup/合并计划.md §C5
    // --- L2: sessionManager + inboxReader + outboxWriter ---

    const makeDialogStore = (): DialogStore =>
      createDialogStore(systemFs, DIALOG_DIR, auditWriter, 'current.json', clawId);

    let sessionManager: DialogStore;
    try {
      sessionManager = makeDialogStore();
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=session_manager`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: DialogStore construct failed: ${errMsg(e)}`, { cause: e });
    }

    // phase470: inject mainDialogStore after sessionManager is available
    taskSystem.setMainDialogStore(sessionManager);

    let inboxReader: InboxReader;
    try {
      inboxReader = createInboxReader(systemFs, auditWriter, 'inbox');
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=inbox_reader`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: InboxReader construct failed: ${errMsg(e)}`, { cause: e });
    }

    // phase 1424: ContractAuditor 装配 — 周期 LLM 对照 expectations 检查 + inbox 高优反馈
    // llm 可缺省（早期装配未注入 llm 时跳过 auditor / contract.audit_interval 默 0 时也不触发）
    if (llm) {
      try {
        const clawInbox = InboxWriter.__internal_create(
          systemFs,
          makeInboxPath(path.join(clawDir, 'inbox', 'pending')),
          auditWriter,
        );
        const auditor = new ContractAuditor({
          audit: auditWriter,
          fs: systemFs,
          inbox: clawInbox,
          llm,
          inboxPendingDir: 'inbox/pending',  // 相对 systemFs.baseDir(=clawDir)
        });
        contractManager.attachAuditor(auditor);
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_auditor`, `phase=construct`, `reason=${errMsg(e)}`);
        // 非致命：装配失败不阻塞 Runtime 起步 / contract auditor 默 disabled 状态
      }
    }

    // phase 1414: inbox 消息 formatter 注册表（业主自家 register、Runtime 仅 dispatch）
    const formatterRegistry: MessageFormatterRegistry = createMessageFormatterRegistry();
    registerMessagingFormatters(formatterRegistry);                        // 'user_inbox_message' + 'message'
    formatterRegistry.register('user_chat', formatUserChat);               // Gateway 业主
    registerWatchdogFormatters(formatterRegistry);                         // Watchdog 业主：crash_notification + claw_inactivity
    registerContractFormatters(formatterRegistry);                         // ContractSystem 业主：contract_events + 3 verification_*
    registerDaemonFormatters(formatterRegistry);                           // DaemonLoop 业主：startup_check
    registerMemoryFormatters(formatterRegistry);                           // MemorySystem 业主：random_dream + deep_dream
    if (isMotion) {
      // 与 createHeartbeat 同 guard：只 motion 装 heartbeat formatter
      formatterRegistry.register(
        'heartbeat',
        createHeartbeatInboxFormatter({ systemFs, audit: auditWriter }),
      );
    }

    // phase 1469: motion guidance registry (motion-only 装 / claw 装配 undefined)
    // 业主 facts + state schema / Assembly own composer 物理 / 22 type 全 register（含 NO_GUIDANCE sentinel）
    let guidanceRegistry: MotionGuidanceRegistry | undefined;
    if (isMotion) {
      guidanceRegistry = createMotionGuidanceRegistry();
      registerAllMotionGuidance(guidanceRegistry);
    }

    // --- Snapshot（phase155B 已搬，但需保证在 Runtime 之前） ---
    let snapshot: Snapshot;
    try {
      snapshot = createSnapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS, [
        path.join(clawDir, TASKS_SYNC_EXEC_DIR),
        path.join(clawDir, TASKS_SYNC_WRITE_DIR),
      ]);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=snapshot`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: Snapshot construct failed: ${errMsg(e)}`, { cause: e });
    }

    const initResult = await snapshot.init();
    if (!initResult.ok) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=snapshot`, `phase=init`, `reason=${initResult.error.kind}`);
      throw new Error(`Assembly: Snapshot.init failed: ${initResult.error.kind}`);
    }

    const recoveryResult = await snapshot.commit('recovery-snapshot');
    if (!recoveryResult.ok) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=snapshot`, `phase=recovery-commit`, `reason=${recoveryResult.error.kind}`);
    }

    // --- StreamWriter 前置（phase182 B.p166-5 升档：setter 双阶段消除） ---
    try {
      streamWriter = createStreamWriter(systemFs, auditWriter, {
        maxFiles: globalConfig.stream?.retention?.max_files ?? null,
        maxDays: globalConfig.stream?.retention?.max_days ?? null,
      });
      streamWriter.open();
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=stream_writer`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: StreamWriter construct failed: ${errMsg(e)}`, { cause: e });
    }

    // contractNotify callback 在 Runtime 构造前形成（注入 deps 而非 setter）
    const contractNotifyCallback = (type: string, data: Record<string, unknown>) => {
      streamWriter!.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });

      // A.6 双链路：motion inbox 只接契约终态事件（决策点）
      // subtask_completed / verification_failed 仅 streamWriter（viewport 可见、motion 决策无用）
      if (type === 'contract_completed') {
        notifyInbox(systemFs, {
          inboxDir: motionInboxDir,
          type: 'contract_events',
          source: 'system',
          priority: 'high',
          body: `[${type}] claw=${clawId} ${formatNotifyData(data)}`,
        }, auditWriter);
      }
    };

    const dependencies: RuntimeDependencies = {
      fsFactory,
      systemFs,
      auditWriter,
      snapshot,
      sessionManager,
      inboxReader,
      outboxWriter,
      llm,
      toolRegistry,
      toolExecutor,
      contractManager,
      taskSystem,
      skillRegistry,
      permissionChecker,  // NEW phase 1273 / 复用 line 287 既有构造
      parentStreamLog: streamWriter!,
      contractNotifyCallback,
      // phase 521: regime switch coordination / Assembly own factory / closure capture 5 const
      dialogStoreFactory: makeDialogStore,
      // phase 1414: inbox 消息 formatter 注册表（业主自家 register）
      formatterRegistry,
      // phase 1469: motion guidance registry（motion-only / claw 装配 undefined）
      guidanceRegistry,
    };

    // 孤儿临时文件清理（从 Runtime.initialize 搬来；Assembly 负责一次性的启动清理）
    cleanupOrphanedTemp(systemFs, clawDir).catch((err: unknown) => {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.CLEANUP_TEMP_FILES_FAILED, `reason=${err instanceof Error ? err.message : String(err)}`);
    });

    // --- Runtime 构造（deps 注入） ---
    let runtime: Runtime;
    try {
      runtime = createRuntime({
        identity: isMotion ? 'motion' : 'claw',
        clawId: isMotion ? MOTION_CLAW_ID : clawId,
        clawDir,
        clawforumRoot: resolveClawforumRoot(clawDir, isMotion),  // phase 1406: 单一 truth source
        llmConfig,
        maxSteps,
        toolProfile,

        idleTimeoutMs,
        dependencies,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=runtime`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: Runtime construct failed: ${errMsg(e)}`, { cause: e });
    }

    // shadow tool — 依赖 Runtime.getTurnSnapshot（L4 turn state 快照）
    // 必须在 runtime 创建后注册，不能提前（runtime 尚未存在）
    toolRegistry.register(createShadowTool({
      getTurnSnapshot: () => ({
        systemPrompt: runtime.getCurrentSystemPrompt(),
        tools: runtime.getCurrentTools(),
        messages: runtime.getCurrentMessages(),
      }),
    }));

    // --- Gateway (motion only, offline mode) ---
    let gateway: Gateway | undefined;
    if (isMotion) {
      try {
        gateway = createGateway({
          streamFactory: (onEvent) => createStreamReader(systemFs, STREAM_FILE, onEvent, auditWriter),
          getInitialOffset: () => findRecentTurnStartOffset(systemFs, STREAM_FILE),
          transport: undefined,                      // offline mode (latent: future wire UnixDomainSocketTransport per phase 1055)
          interrupt: () => runtime.abort(),          // offline 不会触发，留接口
          audit: auditWriter,
        });
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=gateway`, `phase=construct`, `reason=${errMsg(e)}`);
        throw new Error(`Assembly: Gateway construct failed: ${errMsg(e)}`, { cause: e });
      }
      // ask_user 工具：motion 启 / claw 不启（决策 #25：用户 ↔ motion ↔ claw 中介）
      toolRegistry.register(createAskUserTool(gateway));
      // notify_claw 工具：motion-only（D11 单向访问特权 / phase 477 design / phase 822 实施 / phase 1021 P0 三重错位 hotfix）
      // motion → claw inbox push、与 send（claw → 自己 outbox pull）物理不同、§10.3 不对称设计
      // fs = parentFs (baseDir = .clawforum/) align clawforumRoot、避免 systemFs (baseDir = motion/) 沙箱拒 sibling claws/<to> absolute path
      toolRegistry.register(createNotifyClawTool({
        fs: parentFs,
        clawforumRoot: resolveClawforumRoot(clawDir, true),  // phase 1406: motion-only context (motion clawDir = <root>/motion → root)
        audit: auditWriter,
      }));
    }

    // --- 5. detectUncleanExit (daemon.ts L152) ---
    detectUncleanExit(clawDir, auditWriter, systemFs);

    // --- 6. Heartbeat (motion + interval > 0, daemon.ts L158-169) ---
    let heartbeat: Heartbeat | undefined;
    if (isMotion) {
      const heartbeatIntervalMs = globalConfig.motion?.heartbeat_interval_ms ?? 0;
      if (heartbeatIntervalMs > 0) {
        try {
          heartbeat = createHeartbeat(resolveClawforumRoot(clawDir, true), {  // phase 1406: motion-only context
            interval: heartbeatIntervalMs / 1000,
            fs: parentFs,
            audit: auditWriter,
            inboxReader,
          });
        } catch (e) {
          auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=heartbeat`, `phase=construct`, `reason=${errMsg(e)}`);
          throw new Error(`Assembly: Heartbeat construct failed: ${errMsg(e)}`, { cause: e });
        }
      }
    }

    // --- 7. CronRunner (motion + cron.enabled, daemon.ts L187-248) ---
    let cronRunner: CronRunner | undefined;
    let messaging: Messaging | undefined;
    if (isMotion && (globalConfig.cron?.enabled ?? true)) {
      const clawforumRoot = resolveClawforumRoot(clawDir, true);  // phase 1406: motion-only context (isMotion+cron guard)
      const tickMs = globalConfig.cron?.tick_interval_ms ?? CRON_TICK_INTERVAL_MS;
      const diskLimitMB = globalConfig.watchdog?.disk_warning_mb ?? DEFAULT_DISK_WARNING_MB;
      const diskScheduleStr = globalConfig.cron?.jobs?.disk_monitor?.schedule ?? 'hourly';

      // phase155D：预制 clawforumFs，被 disk-monitor / dream-trigger 闭包共用（冻结 §6）
      // 失败语义：与既有模块（Snapshot / StreamWriter）一致 —— audit 写 assemble_failed 后上抛
      let clawforumFs: FileSystem;
      try {
        clawforumFs = fsFactory(clawforumRoot);
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=fs_construct`, `reason=${errMsg(e)}`);
        throw new Error(`Assembly: clawforumFs construct failed: ${errMsg(e)}`, { cause: e });
      }

      // phase 1333: Messaging instance for cron outbox-drain tick trigger
      messaging = createMessaging({ clawforumRoot, fs: clawforumFs, audit: auditWriter });

      // --- MemorySystem (L5, motion only) ---
      let memorySystem: MemorySystem | undefined;
      if (isMotion) {
        // M#3: random-dream 读取 contract progress 走 ContractSystem API（phase 1104）
        const contractSystemCache = new Map<string, import('../core/contract/index.js').ContractSystem>();
        disposeContractSystems = async () => {
          for (const cs of contractSystemCache.values()) {
            await cs.close();
          }
          contractSystemCache.clear();
        };
        const getContractProgress = async (clawId: ClawId, contractId: ContractId): Promise<import('../core/contract/index.js').ProgressData> => {
          let cs = contractSystemCache.get(clawId);
          if (!cs) {
            const cDir = makeClawDir(path.join(clawforumRoot, CLAWS_DIR, clawId));
            const cFs = fsFactory(cDir);
            const cAudit = createSystemAudit(cFs, cDir);
            cs = createContractSystem({ clawDir: cDir, clawId, fs: cFs, audit: cAudit, llm, toolRegistry, toolTimeoutMs, fsFactory, clawforumRoot });
            contractSystemCache.set(clawId, cs);
          }
          return cs.getProgress(contractId);
        };

        try {
          memorySystem = createMemorySystem({
            clawforumRoot,
            motionDir: clawDir,
            fs: clawforumFs,
            motionFs: systemFs,
            audit: auditWriter,
            taskSystem: runtime.getTaskSystem(),
            llmService: llm,
            llmConfig,
            maxCompressionTokens: globalConfig.cron?.jobs?.dream_trigger?.max_compression_tokens,
            clawFsFactory: fsFactory,
            getContractProgress,
          });
        } catch (e) {
          auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=memory_system`, `phase=construct`, `reason=${errMsg(e)}`);
          throw new Error(`Assembly: MemorySystem construct failed: ${errMsg(e)}`, { cause: e });
        }
        toolRegistry.register(memorySearchTool);
      }

      // phase 724 α single audit pipe：cron handler 复用主 auditWriter / 删冗余 instance
      // （ML M#3 资源唯一归属 / motion/audit.tsv 单一 owner = L126 主 auditWriter）
      const diskMonitorInbox = InboxWriter.__internal_create(clawforumFs, makeInboxPath(motionInboxDir), auditWriter);

      try {
        cronRunner = createCronRunner([
          {
            name: 'disk-monitor',
            enabled: globalConfig.cron?.jobs?.disk_monitor?.enabled ?? true,
            schedule: parseSchedule(diskScheduleStr, auditWriter),
            handler: (signal) => runDiskMonitor({
              clawforumRoot,
              limitMB: diskLimitMB,
              fs: clawforumFs,
              audit: auditWriter,
              motionAudit: auditWriter,  // phase 724 α：主 auditWriter 单 instance 复用
              motionInbox: diskMonitorInbox,
              signal,
            }),
            timeoutMs: DISK_MONITOR_CRON_TIMEOUT_MS,
          },
          {
            name: 'llm-stats',
            enabled: globalConfig.cron?.jobs?.llm_stats?.enabled ?? true,
            schedule: parseSchedule(globalConfig.cron?.jobs?.llm_stats?.schedule ?? 'daily:06:00', auditWriter),
            handler: (signal) => runLlmStats({
              clawforumRoot,
              motionDir: clawDir,
              clawforumFs,
              motionFs: systemFs,
              audit: auditWriter,
              signal,
            }),
            timeoutMs: LLM_STATS_CRON_TIMEOUT_MS,
          },
          {
            name: 'dream-trigger',
            enabled: globalConfig.cron?.jobs?.dream_trigger?.enabled ?? false,
            schedule: parseSchedule(globalConfig.cron?.jobs?.dream_trigger?.schedule ?? 'daily:04:00', auditWriter),
            handler: async (signal) => {
              if (!memorySystem) return;
              await memorySystem.runDeepDream(undefined, { signal });
              await memorySystem.runRandomDream({ signal });
            },
            timeoutMs: DREAM_TRIGGER_CRON_TIMEOUT_MS,
          },
          {
            name: 'metrics-snapshot',
            enabled: globalConfig.cron?.jobs?.metrics_snapshot?.enabled ?? true,
            schedule: parseSchedule(globalConfig.cron?.jobs?.metrics_snapshot?.schedule ?? 'interval:5m', auditWriter),
            handler: (signal) => runMetricsSnapshot({
              motionDir: makeClawDir(path.join(clawforumRoot, 'motion')),
              fs: clawforumFs,
              audit: auditWriter,
              signal,
            }),
            timeoutMs: METRICS_SNAPSHOT_CRON_TIMEOUT_MS,
          },
          {
            name: 'contract-observer',
            enabled: true,
            schedule: parseSchedule(globalConfig.cron?.jobs?.contract_observer?.schedule ?? 'interval:1m', auditWriter),
            handler: (signal) => runContractObserver({
              clawforumRoot,
              fs: clawforumFs,
              motionAudit: auditWriter,  // phase 724 α：主 auditWriter 单 instance 复用
              notifyClaw: (fs, clawforumRoot, targetClawId, payload, audit) => notifyClaw(fs, clawforumRoot, targetClawId, payload, audit),
              signal,
            }),
            timeoutMs: CONTRACT_OBSERVER_CRON_TIMEOUT_MS,
          },
          {
            name: 'git-gc-weekly',
            enabled: globalConfig.cron?.jobs?.git_gc_weekly?.enabled ?? true,
            schedule: parseSchedule(globalConfig.cron?.jobs?.git_gc_weekly?.schedule ?? 'daily:03:00', auditWriter),
            handler: (signal) => runGitGcWeekly({
              clawforumRoot,
              fs: clawforumFs,
              audit: auditWriter,
              signal,
            }),
            timeoutMs: GIT_GC_WEEKLY_CRON_TIMEOUT_MS,
          },
          {
            name: 'retention-cleanup',
            enabled: globalConfig.cron?.jobs?.retention_cleanup?.enabled ?? true,
            schedule: parseSchedule(globalConfig.cron?.jobs?.retention_cleanup?.schedule ?? 'daily:04:00', auditWriter),
            handler: (signal) => runRetentionCleanup({
              motionDir: clawDir,
              fs: clawforumFs,
              audit: auditWriter,
              maxDays: {
                inbox: globalConfig.retention?.inbox_max_days ?? 30,
                outbox: globalConfig.retention?.outbox_max_days ?? 30,
                tasks: globalConfig.retention?.tasks_max_days ?? 60,
                dialog: globalConfig.retention?.dialog_max_days ?? 90,
              },
              signal,
            }),
            timeoutMs: RETENTION_CLEANUP_CRON_TIMEOUT_MS,
          },
          {
            name: 'audit-size-monitor',
            enabled: globalConfig.cron?.jobs?.audit_size_monitor?.enabled ?? true,
            schedule: parseSchedule(globalConfig.cron?.jobs?.audit_size_monitor?.schedule ?? 'interval:6h', auditWriter),
            handler: (signal) => runAuditSizeMonitor({
              fs: clawforumFs,
              audit: auditWriter,
              clawforumRoot,
              motionAuditPath: path.join(clawforumRoot, 'motion', 'audit.tsv'),
              rootAuditPath: path.join(clawforumRoot, 'audit.tsv'),
              motionInbox: diskMonitorInbox,
              signal,
            }),
            timeoutMs: AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS,
          },
          {
            name: 'outbox-drain',
            enabled: globalConfig.cron?.jobs?.outbox_drain?.enabled ?? true,
            schedule: parseSchedule(globalConfig.cron?.jobs?.outbox_drain?.schedule ?? 'interval:30s', auditWriter),
            handler: (signal) => runOutboxDrain({
              messaging: messaging!,
              limitPerClaw: OUTBOX_DRAIN_DEFAULT_LIMIT,
              signal,
              audit: auditWriter,
            }),
            timeoutMs: OUTBOX_DRAIN_CRON_TIMEOUT_MS,
          },
          {
            name: 'sunset-monitor',
            enabled: globalConfig.cron?.jobs?.sunset_monitor?.enabled ?? true,
            schedule: parseSchedule(globalConfig.cron?.jobs?.sunset_monitor?.schedule ?? 'interval:30d', auditWriter),
            handler: (signal) => runSunsetMonitor({
              fs: clawforumFs,
              audit: auditWriter,
              clawforumRoot,
              motionAuditPath: path.join(clawforumRoot, 'motion', 'audit.tsv'),
              rootAuditPath: path.join(clawforumRoot, 'audit.tsv'),
              legacyConsts: [
                'pid_file_legacy_format',
                'inbox_legacy_claw_id_field',
                'legacy_pending_task_no_mode',
                'contract_yaml_legacy_acceptance_field',
                'contract_yaml_legacy_escalation_field',
              ],
              motionInbox: diskMonitorInbox,
              signal,
            }),
            timeoutMs: SUNSET_MONITOR_CRON_TIMEOUT_MS,
          },
        ], auditWriter);
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=construct`, `reason=${errMsg(e)}`);
        throw new Error(`Assembly: CronRunner construct failed: ${errMsg(e)}`, { cause: e });
      }

      try {
        cronRunner.start(tickMs);
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=start`, `reason=${errMsg(e)}`);
        throw new Error(`Assembly: CronRunner start failed: ${errMsg(e)}`, { cause: e });
      }
    }

    // --- 8. 契约 §4 audit daemon_started ---
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_STARTED, `clawId=${clawId}`, `pid=${process.pid}`);
    streamWriter!.write({ ts: Date.now(), type: 'daemon_started', clawId, pid: process.pid });

    return {
      clawId: config.clawId,
      runtime,
      streamWriter: streamWriter!,
      snapshot,
      processManager,
      auditWriter,
      cronRunner,
      heartbeat,
      gateway,
      evolutionSystem,
      disposeContractSystems,
      messaging,
    };
  } catch (e) {
    // Best-effort cleanup of already-constructed resources
    streamWriter?.close?.();
    llm?.close()?.catch(() => {
      // silent: assemble throw 兜底 teardown 路径，原 error e 在末尾 throw 不丢失；llm.close 异步失败属次生 error，无 auditWriter 可信通道（catch 内 auditWriter 自身可能未完成构造）
    });
    if (lockAcquired) {
      try {
        processManager.releaseLock(clawId);
      } catch (releaseErr) {
        auditWriter.write(
          ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
          `module=lockfile_release`,
          `phase=assemble_throw_cleanup`,
          `reason=${errMsg(releaseErr)}`,
        );
      }
    }
    throw e;
  }
}

function formatNotifyData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
