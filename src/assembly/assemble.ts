import path from 'path';
import * as fsNative from 'fs';

import { AuditWriter } from '../foundation/audit/writer.js';
import { SNAPSHOT_IGNORE_PATTERNS, createSnapshot } from '../foundation/snapshot/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import { createStreamWriter } from '../foundation/stream/index.js';
import type { StreamWriter } from '../foundation/stream/writer.js';
import type { ProcessManager } from '../foundation/process-manager/manager.js';
import { NodeFileSystem } from '../foundation/fs/node-fs.js';
import { createAgentProcessManager } from '../cli/commands/process-manager-factory.js';
import { type ClawRuntime, type RuntimeDependencies } from '../core/runtime.js';
import { type MotionRuntime } from '../core/motion/runtime.js';
import { createRuntime } from '../core/create-runtime.js';
import { LLMServiceImpl } from '../foundation/llm/service.js';
import { JsonlLogger } from '../foundation/monitor/monitor.js';
import { ToolRegistryImpl } from '../core/tools/registry.js';
import { ToolExecutorImpl } from '../core/tools/executor.js';
import { SkillRegistry } from '../core/skill/registry.js';
import { ContractManager, createContractManager } from '../core/contract/index.js';
import { createTaskSystem } from '../core/task/index.js';
import type { TaskSystem } from '../core/task/system.js';
import { ContextInjector } from '../core/dialog/injector.js';
import { ExecContextImpl } from '../core/tools/context.js';
import { registerBuiltinTools } from '../core/tools/builtins/index.js';
import { createInboxReader, createOutboxWriter } from '../foundation/messaging/index.js';
import { createSessionManager } from '../foundation/session-store/index.js';
import type { InboxReader } from '../foundation/messaging/index.js';
import type { OutboxWriter } from '../core/communication/index.js';
import type { SessionManager } from '../foundation/session-store/index.js';

import { Heartbeat } from '../core/heartbeat.js';
import { CronRunner, parseSchedule } from '../core/cron/runner.js';
import { runDiskMonitor } from '../core/cron/jobs/disk-monitor.js';
import { runLlmStats } from '../core/cron/jobs/llm-stats.js';
import { runDeepDream } from '../core/cron/jobs/deep-dream.js';
import { runRandomDream } from '../core/cron/jobs/random-dream.js';
import { runContractObserver } from '../core/cron/jobs/contract-observer.js';
import { buildLLMConfig } from '../cli/config.js';
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_CONCURRENT_TASKS } from '../constants.js';

import type { AssembleConfig, Instances } from './index.js';
import { LockConflictError } from './index.js';
import { createGateway } from '../core/gateway/gateway.js';
import type { Gateway } from '../core/gateway/types.js';
import { createStreamReader, STREAM_FILE } from '../foundation/stream/index.js';

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
      auditWriter.write('daemon_unclean_exit', `last_ts=${lastTs}`);
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
  // systemFs: used by AuditWriter / Snapshot / SessionManager / Skill/Contract/Outbox/Inbox/Task/Context/Stream
  const systemFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
  // clawFs: used by tools via ExecContextImpl.fs
  const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: true });
  const parentFs = new NodeFileSystem({ baseDir: path.join(clawDir, '..'), enforcePermissions: false });

  // --- 1. AuditWriter (daemon.ts L100-104) ---
  let auditWriter: AuditWriter;
  try {
    auditWriter = new AuditWriter(systemFs, 'audit.tsv', auditMaxSizeMb);
  } catch (e) {
    throw new Error(`Assembly: AuditWriter construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- 2. ProcessManager + acquireLock (daemon.ts L107-108) ---
  let processManager: ProcessManager;
  try {
    processManager = createAgentProcessManager(auditWriter);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=process_manager`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ProcessManager construct failed: ${errMsg(e)}`, { cause: e });
  }

  try {
    processManager.acquireLock(clawId);
  } catch (e) {
    auditWriter.write('assemble_lock_conflict', `clawId=${clawId}`);
    throw new LockConflictError(clawId, errMsg(e));
  }

  // --- 3. Runtime (daemon.ts L111-137) ---
  let llmConfig: ReturnType<typeof buildLLMConfig>;
  try {
    llmConfig = isMotion
      ? buildLLMConfig(globalConfig)
      : buildLLMConfig(globalConfig, clawConfig!);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=llm_config`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: buildLLMConfig failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: 派生配置统一求值（motion vs claw 分叉） ---
  const maxSteps = isMotion
    ? (globalConfig.motion?.max_steps ?? DEFAULT_MAX_STEPS)
    : clawConfig!.max_steps;
  const maxConcurrent = isMotion
    ? (globalConfig.motion?.max_concurrent_tasks ?? DEFAULT_MAX_CONCURRENT_TASKS)
    : (clawConfig!.max_concurrent_tasks ?? DEFAULT_MAX_CONCURRENT_TASKS);
  const toolProfile = isMotion ? 'full' : clawConfig!.tool_profile;
  const subagentMaxSteps = isMotion
    ? globalConfig.motion?.subagent_max_steps
    : clawConfig!.subagent_max_steps;
  const toolTimeoutMs = globalConfig.tool_timeout_ms;
  const idleTimeoutMs = globalConfig.motion?.llm_idle_timeout_ms;

  // --- L3-L5: monitor ---
  const logsDir = path.join(clawDir, 'logs');
  let monitor: JsonlLogger;
  try {
    monitor = new JsonlLogger({ logsDir });
  } catch (e) {
    auditWriter.write('assemble_failed', `module=monitor`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: JsonlLogger construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: llm ---
  let llm: LLMServiceImpl;
  try {
    llm = new LLMServiceImpl(llmConfig);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=llm`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: LLMService construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: toolRegistry（空；DispatchTool 留给 Runtime） ---
  let toolRegistry: ToolRegistryImpl;
  try {
    toolRegistry = new ToolRegistryImpl();
    registerBuiltinTools(toolRegistry);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=tool_registry`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ToolRegistry construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: skillRegistry + loadAll ---
  let skillRegistry: SkillRegistry;
  try {
    skillRegistry = new SkillRegistry(systemFs, 'skills');
  } catch (e) {
    auditWriter.write('assemble_failed', `module=skill_registry`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: SkillRegistry construct failed: ${errMsg(e)}`, { cause: e });
  }
  try {
    await skillRegistry.loadAll();
  } catch (e) {
    auditWriter.write('assemble_failed', `module=skill_registry`, `phase=init`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: SkillRegistry.loadAll failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: verifierRegistry + contractManager ---
  let contractManager: ContractManager;
  try {
    const verifierRegistry = new ToolRegistryImpl();
    for (const tool of toolRegistry.getForProfile('verifier')) {
      verifierRegistry.register(tool);
    }
    contractManager = createContractManager(
      clawDir, clawId, systemFs, monitor, llm, verifierRegistry, auditWriter,
    );
  } catch (e) {
    auditWriter.write('assemble_failed', `module=contract_manager`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ContractManager construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L2: outboxWriter ---
  let outboxWriter: OutboxWriter;
  try {
    outboxWriter = createOutboxWriter(clawId, clawDir, systemFs, auditWriter);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=outbox_writer`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: OutboxWriter construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: taskSystem（仅构造，不调 initialize / startDispatch；业务动作归 Runtime） ---
  let taskSystem: TaskSystem;
  try {
    taskSystem = createTaskSystem(clawDir, systemFs, {
      maxConcurrent,
      auditWriter,
      llm,
      skillRegistry,
      contractManager,
      outboxWriter,
    });
  } catch (e) {
    auditWriter.write('assemble_failed', `module=task_system`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: TaskSystem construct failed: ${errMsg(e)}`, { cause: e });
  }
  // NOTE: taskSystem.initialize() / startDispatch() 属 TaskSystem 业务语义，由 Runtime.initialize() 调用
  //       参见 接口冻结.md §4 "业务动作归属" + 原则 #2

  // --- L3-L5: contextInjector ---
  let contextInjector: ContextInjector;
  try {
    contextInjector = new ContextInjector({ fs: systemFs, skillRegistry, contractManager });
  } catch (e) {
    auditWriter.write('assemble_failed', `module=context_injector`, `phase=construct`, `reason=${errMsg(e)}`);
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
      monitor,
      llm,
      maxSteps,
      taskSystem,
      skillRegistry,
      contractManager,
      subagentMaxSteps,
      outboxWriter,
      auditWriter,
    });
  } catch (e) {
    auditWriter.write('assemble_failed', `module=exec_context`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ExecContextImpl construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- L3-L5: toolExecutor ---
  let toolExecutor: ToolExecutorImpl;
  try {
    toolExecutor = new ToolExecutorImpl(toolRegistry, toolTimeoutMs);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=tool_executor`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: ToolExecutorImpl construct failed: ${errMsg(e)}`, { cause: e });
  }

  // NOTE: 此段 L2 装配位于 L3-L5 之后，是 phase155C squash-merge 时为避免大规模代码移动保留的形态。
  // 语义正确（变量作用域覆盖全函数，依赖链仍 DAG），但与 phase155B 原拓扑"L2 先于 L3-L5"不一致。
  // 如要对齐拓扑走独立 phase 处理，见 coding plan/phase155/phase155C/fixup/合并计划.md §C5
  // --- L2: sessionManager + inboxReader + outboxWriter ---
  let sessionManager: SessionManager;
  try {
    sessionManager = createSessionManager(systemFs, 'dialog', auditWriter, clawId);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=session_manager`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: SessionManager construct failed: ${errMsg(e)}`, { cause: e });
  }

  let inboxReader: InboxReader;
  try {
    inboxReader = createInboxReader(systemFs, auditWriter, 'inbox');
  } catch (e) {
    auditWriter.write('assemble_failed', `module=inbox_reader`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: InboxReader construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- Snapshot（phase155B 已搬，但需保证在 Runtime 之前） ---
  let snapshot: Snapshot;
  try {
    snapshot = createSnapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=snapshot`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: Snapshot construct failed: ${errMsg(e)}`, { cause: e });
  }

  const initResult = await snapshot.init();
  if (!initResult.ok) {
    auditWriter.write('assemble_failed', `module=snapshot`, `phase=init`, `reason=${initResult.error.kind}`);
    throw new Error(`Assembly: Snapshot.init failed: ${initResult.error.kind}`);
  }

  const recoveryResult = await snapshot.commit('recovery-snapshot');
  if (!recoveryResult.ok) {
    auditWriter.write('assemble_failed', `module=snapshot`, `phase=recovery-commit`, `reason=${recoveryResult.error.kind}`);
  }

  const dependencies: RuntimeDependencies = {
    systemFs,
    clawFs,
    auditWriter,
    snapshot,
    sessionManager,
    inboxReader,
    outboxWriter,
    monitor,
    llm,
    toolRegistry,
    toolExecutor,
    skillRegistry,
    contractManager,
    taskSystem,
    contextInjector,
    execContext,
  };

  // 孤儿临时文件清理（从 Runtime.initialize 搬来；Assembly 负责一次性的启动清理）
  systemFs.cleanupTempFiles().catch((err: unknown) => {
    auditWriter.write('cleanup_temp_files_failed', `reason=${err instanceof Error ? err.message : String(err)}`);
  });

  // --- Runtime 构造（deps 注入） ---
  let runtime: MotionRuntime | ClawRuntime;
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
    auditWriter.write('assemble_failed', `module=runtime`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: Runtime construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- Gateway (motion only, offline mode; phase157 装配, ask_user 注册留 phase169+) ---
  let gateway: Gateway | undefined;
  if (isMotion) {
    try {
      gateway = createGateway({
        streamFactory: (onEvent) => createStreamReader(systemFs, STREAM_FILE, onEvent, auditWriter),
        transport: undefined,                      // offline mode
        interrupt: () => runtime.abort(),          // offline 不会触发，留接口
      });
    } catch (e) {
      auditWriter.write('assemble_failed', `module=gateway`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: Gateway construct failed: ${errMsg(e)}`, { cause: e });
    }
  }

  // --- 5. detectUncleanExit (daemon.ts L152) ---
  detectUncleanExit(clawDir, auditWriter);

  // --- 6. Heartbeat (motion + interval > 0, daemon.ts L158-169) ---
  let heartbeat: Heartbeat | undefined;
  if (isMotion) {
    const heartbeatIntervalMs = globalConfig.motion?.heartbeat_interval_ms ?? 0;
    if (heartbeatIntervalMs > 0) {
      try {
        heartbeat = new Heartbeat(path.join(clawDir, '..'), {
          interval: heartbeatIntervalMs / 1000,
          fs: parentFs,
          audit: auditWriter,
        });
      } catch (e) {
        auditWriter.write('assemble_failed', `module=heartbeat`, `phase=construct`, `reason=${errMsg(e)}`);
        throw new Error(`Assembly: Heartbeat construct failed: ${errMsg(e)}`, { cause: e });
      }
    }
  }

  // --- 7. StreamWriter + open + stream event + setParentStreamLog (daemon.ts L172-184) ---
  let streamWriter: StreamWriter;
  try {
    streamWriter = createStreamWriter(systemFs, auditWriter, {
      maxFiles: globalConfig.stream?.retention?.max_files ?? null,
      maxDays: globalConfig.stream?.retention?.max_days ?? null,
    });
    streamWriter.open();
    runtime.setParentStreamLog(streamWriter);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=stream_writer`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: StreamWriter construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- 8. CronRunner (motion + cron.enabled, daemon.ts L187-248) ---
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
      clawforumFs = new NodeFileSystem({ baseDir: clawforumDir, enforcePermissions: false });
    } catch (e) {
      auditWriter.write('assemble_failed', `module=cron_runner`, `phase=fs_construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: clawforumFs construct failed: ${errMsg(e)}`, { cause: e });
    }

    try {
      cronRunner = new CronRunner([
        {
          name: 'disk-monitor',
          enabled: globalConfig.cron?.jobs?.disk_monitor?.enabled ?? true,
          schedule: parseSchedule(diskScheduleStr),
          handler: () => runDiskMonitor({
            clawforumDir,
            motionInboxDir: path.join(clawDir, 'inbox', 'pending'),
            limitMB: diskLimitMB,
            fs: clawforumFs,
          }),
        },
        {
          name: 'llm-stats',
          enabled: globalConfig.cron?.jobs?.llm_stats?.enabled ?? true,
          schedule: parseSchedule(globalConfig.cron?.jobs?.llm_stats?.schedule ?? 'daily:06:00'),
          handler: () => runLlmStats({
            clawforumDir,
            motionDir: clawDir,
          }),
        },
        {
          name: 'dream-trigger',
          enabled: globalConfig.cron?.jobs?.dream_trigger?.enabled ?? false,
          schedule: parseSchedule(globalConfig.cron?.jobs?.dream_trigger?.schedule ?? 'daily:04:00'),
          handler: async () => {
            await runDeepDream({
              clawforumDir,
              llmConfig,
              maxCompressionTokens: globalConfig.cron?.jobs?.dream_trigger?.max_compression_tokens,
              fs: clawforumFs,
            });
            await runRandomDream({
              clawforumDir,
              motionDir: clawDir,
              taskSystem: runtime.getTaskSystem(),
              fs: clawforumFs,
            });
          },
        },
        {
          name: 'contract-observer',
          enabled: true,
          schedule: parseSchedule(globalConfig.cron?.jobs?.contract_observer?.schedule ?? 'interval:1m'),
          handler: () => runContractObserver({
            clawforumDir,
            motionInboxDir: path.join(clawDir, 'inbox', 'pending'),
          }),
        },
      ]);
    } catch (e) {
      auditWriter.write('assemble_failed', `module=cron_runner`, `phase=construct`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: CronRunner construct failed: ${errMsg(e)}`, { cause: e });
    }

    try {
      cronRunner.start(tickMs);
    } catch (e) {
      auditWriter.write('assemble_failed', `module=cron_runner`, `phase=start`, `reason=${errMsg(e)}`);
      throw new Error(`Assembly: CronRunner start failed: ${errMsg(e)}`, { cause: e });
    }
  }

  // --- 9. setContractNotifyCallback (daemon.ts L283-285 上移, 契约 §5 时序对齐) ---
  try {
    runtime.setContractNotifyCallback((type, data) => {
      streamWriter.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });
    });
  } catch (e) {
    auditWriter.write('assemble_failed', `module=runtime`, `phase=set_contract_notify_callback`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: setContractNotifyCallback failed: ${errMsg(e)}`, { cause: e });
  }

  // --- 10. 契约 §4 audit daemon_started ---
  auditWriter.write('daemon_started', `clawId=${clawId}`, `pid=${process.pid}`);
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
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
