import path from 'path';
import * as fsNative from 'fs';

import { createAuditWriter, type AuditWriter } from '../foundation/audit/index.js';
import { SNAPSHOT_IGNORE_PATTERNS, createSnapshot } from '../foundation/snapshot/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import { createStreamWriter } from '../foundation/stream/index.js';
import type { StreamWriter } from '../foundation/stream/writer.js';
import type { ProcessManager } from '../foundation/process-manager/manager.js';
import { NodeFileSystem } from '../foundation/fs/node-fs.js';

import { createAgentProcessManager } from '../foundation/process-manager/agent-factory.js';
import { type Runtime, type RuntimeDependencies } from '../core/runtime/index.js';
import { createRuntime } from '../core/runtime/index.js';
import { createLLMOrchestrator, type LLMOrchestratorImpl } from '../foundation/llm-orchestrator/index.js';
import { createLLMAuditSink } from './llm-audit-sink.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import { createToolRegistry, type ToolRegistryImpl } from '../foundation/tools/index.js';
import { createToolExecutor, type ToolExecutorImpl } from '../foundation/tools/index.js';
import { createSkillSystem, SkillSystem } from '../foundation/skill-system/index.js';
import { SKILLS_DIR_DEFAULT } from '../foundation/skill-system/skill-paths.js';
import { ContractSystem, createContractSystem } from '../core/contract/index.js';
import { createEvolutionSystem } from '../core/evolution-system/index.js';
import type { EvolutionSystem } from '../core/evolution-system/index.js';

import { createTaskSystem } from '../core/task/index.js';
import type { TaskSystem } from '../core/task/system.js';
import { dispatchContractExtractPostProcessor } from '../core/task/post-processors/dispatch-contract-extract.js';
import { createContextInjector, type ContextInjector } from '../core/dialog/index.js';
import { ExecContextImpl } from '../foundation/tools/context.js';
import { registerBuiltinTools } from '../foundation/tools/builtins/index.js';
import { createFileTools } from '../foundation/file-tool/index.js';
import { createCommandTools } from '../foundation/command-tool/index.js';
import { spawnTool } from '../core/task/tools/spawn.js';
import { cleanupOrphanedTemp } from './cleanup.js';
import { createInboxReader, createOutboxWriter, notifyInbox } from '../foundation/messaging/index.js';
import { doneTool } from '../core/contract/index.js';
import { createContractStatusPort } from '../core/contract/status-port-impl.js';
import { statusTool } from '../foundation/tools/builtins/status.js';
import { skillTool } from '../foundation/tools/builtins/skill.js';
import { sendTool } from '../foundation/messaging/tools/send.js';
import { createDialogStore } from '../foundation/dialog-store/index.js';
import type { InboxReader } from '../foundation/messaging/index.js';
import type { OutboxWriter } from '../foundation/messaging/index.js';
import type { DialogStore } from '../foundation/dialog-store/index.js';

import { createHeartbeat, type Heartbeat } from '../core/runtime/index.js';
import { createCronRunner, parseSchedule, CronRunner } from '../core/cron/index.js';
import { runDiskMonitor } from '../core/cron/jobs/disk-monitor.js';
import { runLlmStats } from '../core/cron/jobs/llm-stats.js';
import { createMemorySystem, memorySearchTool } from '../core/memory/index.js';
import type { MemorySystem } from '../core/memory/index.js';
import { runContractObserver } from '../core/contract/jobs/contract-observer.js';
import { buildLLMConfig } from '../foundation/config/index.js';
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_CONCURRENT_TASKS } from '../constants.js';

import type { AssembleConfig, Instances } from './index.js';
import { createGateway } from '../core/gateway/gateway.js';
import type { Gateway } from '../core/gateway/types.js';
import { createAskUserTool } from '../core/gateway/ask-user-tool.js';
import { createStreamReader, STREAM_FILE } from '../foundation/stream/index.js';
import { DIALOG_DIR } from '../types/paths.js';

// 内部 helper（从 daemon.ts L42-75 搬入）
function detectUncleanExit(auditDir: string, auditWriter: AuditWriter): void {
  const auditPath = path.join(auditDir, 'audit.tsv');
  if (!fsNative.existsSync(auditPath)) return;
  try {
    const stat = fsNative.statSync(auditPath);
    if (stat.size === 0) return;
    const chunkSize = 4096;
    const offset = Math.max(0, stat.size - chunkSize);
    const fd = fsNative.openSync(auditPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(chunkSize, stat.size));
      fsNative.readSync(fd, buf, 0, buf.length, offset);
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
    } finally {
      fsNative.closeSync(fd);
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn('[assembly] detectUncleanExit failed:', err?.code || err?.message || err);
    }
  }
}

export async function assemble(config: AssembleConfig): Promise<Instances> {
  const { identity, clawId, clawDir, globalConfig, clawConfig } = config;
  const isMotion = identity === 'motion';
  const auditMaxSizeMb = globalConfig.audit?.retention?.max_size_mb ?? null;

  // phase155A + B + C 联合约定：system 组件无权限校验；工具层强制权限校验
  // systemFs: used by AuditWriter / Snapshot / DialogStore / Skill/Contract/Outbox/Inbox/Task/Context/Stream
  const systemFs = new NodeFileSystem({ baseDir: clawDir });
  // clawFs: used by tools via ExecContextImpl.fs
  // phase430: PermissionChecker removed from NodeFileSystem ctor;
  // claw-space boundary is enforced by L4 caller (tools) autonomy.
  const clawFs = new NodeFileSystem({ baseDir: clawDir });
  const parentFs = new NodeFileSystem({ baseDir: path.join(clawDir, '..') });

  // --- 1. AuditWriter (daemon.ts L100-104) ---
  let auditWriter: AuditWriter;
  try {
    auditWriter = createAuditWriter(systemFs, 'audit.tsv', auditMaxSizeMb);
  } catch (e) {
    throw new Error(`Assembly: AuditWriter construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- 2. ProcessManager + acquireLock (daemon.ts L107-108) ---
  let processManager: ProcessManager;
  try {
    processManager = createAgentProcessManager(auditWriter);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=process_manager`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ProcessManager construct failed: ${errMsg(e)}`, { cause: e });
  }

  try {
    processManager.acquireLock(clawId);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_LOCK_CONFLICT, `clawId=${clawId}`);
    throw e;
  }

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
  const subagentMaxSteps = isMotion
    ? globalConfig.motion?.subagent_max_steps
    : clawConfig!.subagent_max_steps;
  const toolTimeoutMs = globalConfig.tool_timeout_ms;
  const idleTimeoutMs = globalConfig.motion?.llm_idle_timeout_ms;

  // --- L3-L5: llm ---
  let llm: LLMOrchestratorImpl;
  try {
    llm = createLLMOrchestrator({ ...llmConfig, events: createLLMAuditSink(auditWriter) });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=llm`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: LLMOrchestrator construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: toolRegistry（空；DispatchTool 留给 Runtime） ---
  let toolRegistry: ToolRegistryImpl;
  try {
    toolRegistry = createToolRegistry();

    // phase428 FileTool 抽出 → foundation/file-tool/ / Assembly 显式注册
    for (const tool of createFileTools({})) {
      toolRegistry.register(tool);
    }

    registerBuiltinTools(toolRegistry);
    toolRegistry.register(spawnTool);

    // phase378 后 exec 业务归 CommandTool L2 / 不再经 registerBuiltinTools / Assembly 显式注册
    const commandTools = createCommandTools();
    toolRegistry.register(commandTools.exec);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=tool_registry`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ToolRegistry construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: skillRegistry + loadAll ---
  let skillRegistry: SkillSystem;
  try {
    skillRegistry = createSkillSystem(systemFs, SKILLS_DIR_DEFAULT, auditWriter);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=skill_registry`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: SkillSystem construct failed: ${errMsg(e)}`, { cause: e });
  }
  try {
    await skillRegistry.loadAll();
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=skill_registry`, `phase=init`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: SkillSystem.loadAll failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: contractManager ---
  let contractManager: ContractSystem;
  try {
    contractManager = createContractSystem(
      clawDir, clawId, systemFs, auditWriter, llm,
    );
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_manager`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ContractSystem construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L2: outboxWriter ---
  let outboxWriter: OutboxWriter;
  try {
    outboxWriter = createOutboxWriter(clawId, clawDir, systemFs, auditWriter);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=outbox_writer`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: OutboxWriter construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: taskSystem（仅构造，不调 initialize / startDispatch；业务动作归 Runtime） ---
  let taskSystem: TaskSystem;
  try {
    taskSystem = createTaskSystem(clawDir, systemFs, {
      maxConcurrent,
      auditWriter,
      llm,
      contractManager,
      outboxWriter,
    });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=task_system`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: TaskSystem construct failed: ${errMsg(e)}`, { cause: e });
  }
  // phase438: 注册 PostProcessors（装配期）
  taskSystem.addPostProcessor('dispatch-contract-extract', dispatchContractExtractPostProcessor);

  // NOTE: taskSystem.initialize() / startDispatch() 属 TaskSystem 业务语义，由 Runtime.initialize() 调用
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
        skillRegistry,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=evolution_system`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: EvolutionSystem construct failed: ${errMsg(e)}`, { cause: e });
    }

    // Wire ContractSystem.contract_completed → EvolutionSystem.runRetroForContract
    const motionReviewContext = {
      motionFs: systemFs,
      motionBaseDir: clawDir,
      motionAudit: auditWriter,
      clawsBaseDir: path.resolve(clawDir, '..', 'claws'),
    };
    contractManager.onContractCompleted(async (contractId) => {
      await evolutionSystem!.runRetroForContract(contractId, motionReviewContext);
    });
  }

  // --- L3-L5: contextInjector ---
  let contextInjector: ContextInjector;
  try {
    contextInjector = createContextInjector({ fs: systemFs, skillRegistry, contractManager });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=context_injector`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ContextInjector construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: execContext ---
  let execContext: ExecContextImpl;
  try {
    execContext = new ExecContextImpl({
      clawId,
      clawDir,
      profile: toolProfile,
      callerType: 'claw',
      fs: clawFs,
      llm,
      maxSteps,
      subagentMaxSteps,
      auditWriter,
    });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=exec_context`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ExecContextImpl construct failed: ${errMsg(e)}`, { cause: e });
  }

  // 注入工具属性（避免通过 ExecContext 传业务依赖）
  // done 注册：phase360 后 done 业务归 ContractSystem / 不再经 registerBuiltinTools / Assembly 显式注册
  toolRegistry.register(doneTool);
  doneTool.contractManager = contractManager;
  statusTool.contractStatus = createContractStatusPort(contractManager);
  skillTool.skillRegistry = skillRegistry;

  // send 注册：phase440 后 send 业务归 Messaging / 不再经 registerBuiltinTools / Assembly 显式注册
  toolRegistry.register(sendTool);
  sendTool.outboxWriter = outboxWriter;

  // --- L3-L5: toolExecutor ---
  let toolExecutor: ToolExecutorImpl;
  try {
    toolExecutor = createToolExecutor(toolRegistry, toolTimeoutMs);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=tool_executor`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ToolExecutorImpl construct failed: ${errMsg(e)}`, { cause: e });
  }

  // NOTE: 此段 L2 装配位于 L3-L5 之后，是 phase155C squash-merge 时为避免大规模代码移动保留的形态。
  // 语义正确（变量作用域覆盖全函数，依赖链仍 DAG），但与 phase155B 原拓扑"L2 先于 L3-L5"不一致。
  // 如要对齐拓扑走独立 phase 处理，见 coding plan/phase155/phase155C/fixup/合并计划.md §C5
  // --- L2: sessionManager + inboxReader + outboxWriter ---
  let sessionManager: DialogStore;
  try {
    sessionManager = createDialogStore(systemFs, DIALOG_DIR, auditWriter, clawId);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=session_manager`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: DialogStore construct failed: ${errMsg(e)}`, { cause: e });
  }

  let inboxReader: InboxReader;
  try {
    inboxReader = createInboxReader(systemFs, auditWriter, 'inbox');
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=inbox_reader`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: InboxReader construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- Snapshot（phase155B 已搬，但需保证在 Runtime 之前） ---
  let snapshot: Snapshot;
  try {
    snapshot = createSnapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
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
  let streamWriter: StreamWriter;
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

  // A.6 motionInboxDir 提前到 callback 定义前（双链路保险 / cron job 注册块同步引用）
  const motionInboxDir = path.join(clawDir, 'inbox', 'pending');

  // contractNotify callback 在 Runtime 构造前形成（注入 deps 而非 setter）
  const contractNotifyCallback = (type: string, data: Record<string, unknown>) => {
    streamWriter.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });

    // A.6 双链路：motion inbox 实时收契约事件 (D8 事件驱动 align)
    notifyInbox(systemFs, {
      inboxDir: motionInboxDir,
      type: 'contract_events',
      source: 'system',
      priority: 'high',
      body: `[${type}] claw=${clawId} ${formatNotifyData(data)}`,
      filenameTag: 'contract_events',
    }, auditWriter);
  };

  const dependencies: RuntimeDependencies = {
    systemFs,
    clawFs,
    auditWriter,
    snapshot,
    sessionManager,
    inboxReader,
    outboxWriter,
    llm,
    toolRegistry,
    toolExecutor,
    skillRegistry,
    contractManager,
    taskSystem,
    contextInjector,
    execContext,
    parentStreamLog: streamWriter,
    contractNotifyCallback,
  };

  // 孤儿临时文件清理（从 Runtime.initialize 搬来；Assembly 负责一次性的启动清理）
  cleanupOrphanedTemp(clawDir).catch((err: unknown) => {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.CLEANUP_TEMP_FILES_FAILED, `reason=${err instanceof Error ? err.message : String(err)}`);
  });

  // --- Runtime 构造（deps 注入） ---
  let runtime: Runtime;
  try {
    runtime = createRuntime({
      identity: isMotion ? 'motion' : 'claw',
      clawId: isMotion ? 'motion' : clawId,
      clawDir,
      llmConfig,
      maxSteps,
      toolProfile,
      toolTimeoutMs,
      subagentMaxSteps,
      maxConcurrentTasks: maxConcurrent,
      idleTimeoutMs,
      dependencies,
    });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=runtime`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: Runtime construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- Gateway (motion only, offline mode) ---
  let gateway: Gateway | undefined;
  if (isMotion) {
    try {
      gateway = createGateway({
        streamFactory: (onEvent) => createStreamReader(systemFs, STREAM_FILE, onEvent, auditWriter),
        transport: undefined,                      // offline mode
        interrupt: () => runtime.abort(),          // offline 不会触发，留接口
        audit: auditWriter,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=gateway`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: Gateway construct failed: ${errMsg(e)}`, { cause: e });
    }
    // ask_user 工具：motion 启 / claw 不启（决策 #25：用户 ↔ motion ↔ claw 中介）
    toolRegistry.register(createAskUserTool(gateway));
  }

  // --- 5. detectUncleanExit (daemon.ts L152) ---
  detectUncleanExit(clawDir, auditWriter);

  // --- 6. Heartbeat (motion + interval > 0, daemon.ts L158-169) ---
  let heartbeat: Heartbeat | undefined;
  if (isMotion) {
    const heartbeatIntervalMs = globalConfig.motion?.heartbeat_interval_ms ?? 0;
    if (heartbeatIntervalMs > 0) {
      try {
        heartbeat = createHeartbeat(path.join(clawDir, '..'), {
          interval: heartbeatIntervalMs / 1000,
          fs: parentFs,
          audit: auditWriter,
        });
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=heartbeat`, `phase=construct`, `reason=${errMsg(e)}`);
        throw new Error(`Assembly: Heartbeat construct failed: ${errMsg(e)}`, { cause: e });
      }
    }
  }

  // --- 7. CronRunner (motion + cron.enabled, daemon.ts L187-248) ---
  let cronRunner: CronRunner | undefined;
  if (isMotion && (globalConfig.cron?.enabled ?? true)) {
    const clawforumDir = path.join(clawDir, '..');
    const tickMs = globalConfig.cron?.tick_interval_ms ?? 1000;
    const diskLimitMB = globalConfig.watchdog?.disk_warning_mb ?? 500;
    const diskScheduleStr = globalConfig.cron?.jobs?.disk_monitor?.schedule ?? 'hourly';

    // phase155D：预制 clawforumFs，被 disk-monitor / dream-trigger 闭包共用（冻结 §6）
    // 失败语义：与既有模块（Snapshot / StreamWriter）一致 —— audit 写 assemble_failed 后上抛
    let clawforumFs: NodeFileSystem;
    try {
      clawforumFs = new NodeFileSystem({ baseDir: clawforumDir });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=fs_construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: clawforumFs construct failed: ${errMsg(e)}`, { cause: e });
    }

    // --- MemorySystem (L5, motion only) ---
    let memorySystem: MemorySystem | undefined;
    if (isMotion) {
      try {
        memorySystem = createMemorySystem({
          clawforumDir,
          motionDir: clawDir,
          fs: clawforumFs,
          audit: auditWriter,
          taskSystem: runtime.getTaskSystem(),
          llmService: llm,
          llmConfig,
          maxCompressionTokens: globalConfig.cron?.jobs?.dream_trigger?.max_compression_tokens,
        });
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=memory_system`, `phase=construct`, `reason=${errMsg(e)}`);
        throw new Error(`Assembly: MemorySystem construct failed: ${errMsg(e)}`, { cause: e });
      }
      toolRegistry.register(memorySearchTool);
    }

    try {
      cronRunner = createCronRunner([
        {
          name: 'disk-monitor',
          enabled: globalConfig.cron?.jobs?.disk_monitor?.enabled ?? true,
          schedule: parseSchedule(diskScheduleStr, auditWriter),
          handler: () => runDiskMonitor({
            clawforumDir,
            motionInboxDir,
            limitMB: diskLimitMB,
            fs: clawforumFs,
            audit: auditWriter,
          }),
        },
        {
          name: 'llm-stats',
          enabled: globalConfig.cron?.jobs?.llm_stats?.enabled ?? true,
          schedule: parseSchedule(globalConfig.cron?.jobs?.llm_stats?.schedule ?? 'daily:06:00', auditWriter),
          handler: () => runLlmStats({
            clawforumDir,
            motionDir: clawDir,
            audit: auditWriter,
          }),
        },
        {
          name: 'dream-trigger',
          enabled: globalConfig.cron?.jobs?.dream_trigger?.enabled ?? false,
          schedule: parseSchedule(globalConfig.cron?.jobs?.dream_trigger?.schedule ?? 'daily:04:00', auditWriter),
          handler: async () => {
            await memorySystem!.runDeepDream();
            await memorySystem!.runRandomDream();
          },
        },
        {
          name: 'contract-observer',
          enabled: true,
          schedule: parseSchedule(globalConfig.cron?.jobs?.contract_observer?.schedule ?? 'interval:1m', auditWriter),
          handler: () => runContractObserver({
            clawforumDir,
            motionInboxDir,
          }),
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
  streamWriter.write({ ts: Date.now(), type: 'daemon_started', clawId, pid: process.pid });

  return {
    clawId: config.clawId,
    runtime,
    streamWriter,
    snapshot,
    processManager,
    auditWriter,
    cronRunner,
    heartbeat,
    gateway,
    evolutionSystem,
  };
}

function formatNotifyData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
