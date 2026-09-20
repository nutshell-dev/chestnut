/**
 * @module L6.Assembly.RuntimeAssembly
 * @layer L6 装配层
 *
 * assemble() SRP 子工厂：Snapshot + StreamWriter + Runtime 构造与装配。
 * phase 34 Step C：从 assemble() 抽出步骤 12-15（Snapshot → StreamWriter → Runtime → shadowTool）。
 */

// resolveChestnutRoot and CLAWS_DIR removed: phase 263
import path from 'path';
import { formatErr } from '../foundation/node-utils/index.js';
import { createSnapshot } from '../foundation/snapshot/index.js';
// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 归 Assembly 装配组装、走 sibling-direct (合法 assembly 自家)
import { SNAPSHOT_IGNORE_PATTERNS } from './config/snapshot-patterns.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import { type Runtime, type RuntimeDependencies, type GuidanceEnvelope } from '../core/runtime/index.js';
import { createRuntime } from '../core/runtime/index.js';
import { createContractNotificationAdapter } from './contract-notification-adapter.js';
import type { CoreInfraOutput } from './core-infrastructure.js';
import type { BusinessSysOutput } from './business-systems.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
// phase 320: LLM hot-reload — reloader 每次调时重读磁盘
import { loadGlobalConfig, loadClawConfig, resolveLLMConfig } from './config/config-load.js';
import { getClawConfigPath } from '../foundation/claw-identity/index.js';
import { TASKS_SYNC_EXEC_DIR } from '../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../foundation/file-tool/index.js';
import { createShadowTool, SHADOW_DEFAULT_TIMEOUT_MS } from '../core/shadow-system/index.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import type { AssembleConfig } from './types.js';
import { createExecWithHandle, EXEC_TOOL_NAME, EXEC_ASYNC_MIGRATION } from '../foundation/command-tool/index.js';
import { createToolExecutor, createToolRegistry } from '../foundation/tools/index.js';
import { ASYNC_EXEC_SOFT_TIMEOUT_MS } from '../core/async-task-system/index.js';
import { createAntiSelfKillGuard } from './anti-self-kill.js';
// Phase 1396 Step E: EventLoop 执行停滞恢复的 probe/sink 组装（事实源 + Step D narrow sink）
import { listActiveContracts, getActiveContractTimestamp, makeContractId, readContractTerminalFact } from '../core/contract/index.js';
import { readStreamExecutionActivityMs } from '../core/event-loop/index.js';
import type { EventLoopExecutionRecoveryDeps } from '../core/event-loop/index.js';

interface RuntimeAssemblyInput {
  core: CoreInfraOutput;
  business: BusinessSysOutput;
  config: AssembleConfig;
}

interface RuntimeAssemblyOutput {
  snapshot: Snapshot;
  streamWriter: StreamWriter;
  runtime: Runtime;
  executionRecovery: EventLoopExecutionRecoveryDeps;
  /** Phase 1826: 前台恢复 session（daemon 把调度 capability 传给 EventLoop）。 */
  recoverySession: import('../foundation/llm-orchestrator/index.js').LLMRecoverySession;
}

export async function createRuntimeAssembly(
  input: RuntimeAssemblyInput,
): Promise<RuntimeAssemblyOutput> {
  const { core, business, config } = input;
  const { clawDir, identity, clawId } = config;
  const isMotion = identity === 'motion';
  const {
    systemFs, auditWriter, recoverySession, llmConfig,
    maxSteps, toolProfile, idleTimeoutMs, toolTimeoutMs,
    skillRegistry, contractManager, fsFactory, streamWriter,
  } = core;
  const {
    taskSystem, permissionChecker, sessionManager, makeDialogStore,
    inboxReader, formatterRegistry, guidanceRegistry,
    selfInboxDir,
  } = business;

  // --- Snapshot（phase155B 已搬，但需保证在 Runtime 之前） ---
  // phase 1445 Step D（裁定②）：init 内化进 createSnapshot 工厂；init 失败由工厂抛错
  // （message 含 `Snapshot.init failed` 标记），并入本 catch（phase=construct、reason 含 init 字样）。
  let snapshot: Snapshot;
  try {
    snapshot = await createSnapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS, [
      path.join(clawDir, TASKS_SYNC_EXEC_DIR),
      path.join(clawDir, TASKS_SYNC_WRITE_DIR),
    ]);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=snapshot`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: Snapshot construct failed: ${formatErr(e)}`, { cause: e });
  }

  const recoveryResult = await snapshot.commit('recovery-snapshot');
  if (!recoveryResult.ok) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=snapshot`, `phase=recovery-commit`, `reason=${recoveryResult.error.kind}`);
  }

  // --- StreamWriter open：复用 CoreInfrastructure 构造的同一实例 ---
  try {
    streamWriter.open();
    // Phase 833: wire stream writer into AsyncTaskSystem so migrated exec tasks
    // can emit task_started / task_completed viewport events.
    if (typeof taskSystem.setParentStreamLog === 'function') {
      taskSystem.setParentStreamLog(streamWriter);
    }
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=stream_writer`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: StreamWriter construct failed: ${formatErr(e)}`, { cause: e });
  }

  try {
    // phase 1260 Step B: Assembly own transport adapter、构造后直接 attach 到 contractManager。
    // 必须在 createRuntime 之前完成 attach（无短窗口漏 event）；ContractManager setter
    // 只赋 sink、不主动 fire，attach 时无业务副作用。
    const contractNotificationSink = createContractNotificationAdapter({
      streamWriter,
      clawId,
      systemFs,
      selfInboxDir,
      auditWriter,
    });
    contractManager.setOnNotify(contractNotificationSink);

    // === RuntimeDependencies 分组构造（assembly-auditor §六.5 follow-up / 可读性） ===
    const messagingDeps = {
      inboxReader,
    };

    // Phase 773: build a main-agent registry where exec is replaced by the async wrapper.
    // The shared base registry (business.baseToolRegistry) keeps the plain sync exec Tool
    // for subagent spawn paths.
    const mainRegistry = createToolRegistry();
    for (const tool of business.baseToolRegistry.getAll()) {
      if (tool.name !== EXEC_TOOL_NAME) {
        mainRegistry.register(tool);
      }
    }

    let mainToolExecutor: ReturnType<typeof createToolExecutor>;
    if (typeof taskSystem.createAsyncExecWrapper === 'function') {
      const execWithHandle = createExecWithHandle(isMotion ? createAntiSelfKillGuard() : undefined);
      const asyncExecTool = taskSystem.createAsyncExecWrapper({
        execWithHandle: (args, ctx) => execWithHandle(args, ctx),
        softTimeoutMs: ASYNC_EXEC_SOFT_TIMEOUT_MS,
        // phase 1863 (AT-D9/H1)：命令侧执行形态声明（owner: command-tool；缺省可迁移=零漂移）
        migrationPolicy: EXEC_ASYNC_MIGRATION,
      });
      mainRegistry.register(asyncExecTool);
      mainToolExecutor = createToolExecutor(mainRegistry, toolTimeoutMs);
    } else {
      mainToolExecutor = createToolExecutor(mainRegistry, toolTimeoutMs);
    }

    const toolingDeps = {
      toolRegistry: mainRegistry,
      toolExecutor: mainToolExecutor,
      skillRegistry,
      formatterRegistry,
      // phase 27 Step D P5: guidance compose callback hook（motion-only / claw 装配 undefined）
      // phase 1256 Step B: envelope 原样透传 registry（Step A 中间解包已删）
      guidanceCompose: guidanceRegistry
        ? (input: GuidanceEnvelope) => guidanceRegistry.compose(input) ?? null
        : undefined,
    };

    const lifecycleDeps = {
      snapshot,
      sessionManager,
    };

    const dependencies: RuntimeDependencies = {
      fsFactory,
      systemFs,
      auditWriter,
      // Phase 1826: 前台 Runtime 使用 owner 的范围视图（scoped 调用反馈归恢复 session）；
      // 原 orchestrator 仍供子代理/工具/契约等既有注入点使用。
      // phase 1860 (RT-D1)：窄 capability（私有消费）与转发面注入同一 scoped 视图对象。
      llm: recoverySession.llm,
      llmOrchestrator: recoverySession.llm,
      contractManager,
      taskSystem,
      permissionChecker,  // NEW phase 1273 / 复用 line 287 既有构造
      // phase 521: regime switch coordination / Assembly own factory / closure capture 5 const
      dialogStoreFactory: makeDialogStore,
      // Phase 773: plain sync exec registry for subagent spawn paths.
      baseToolRegistry: business.baseToolRegistry,
      // phase 1869 (Step G): 消费适用性判定只读能力（1846 终态事实查询，目录为权威；
      // 只读 stat、无缓存）。注入绑定注入面，Runtime 侧 fail-open 语义见其契约注释。
      contractTerminalFact: (contractId) => readContractTerminalFact(systemFs, makeContractId(contractId)),
      ...messagingDeps,
      ...toolingDeps,
      ...lifecycleDeps,
    };

    // phase 320: configReloader — 每次调时重读磁盘 globalConfig + clawConfig，
    // 由 Runtime._drainOwnInbox 收到 reload_llm_config 消息时调用。
    // **不 capture 起步态 globalConfig/clawConfig**（CLOSURE 反模式：那样永远拿不到新配置）。
    const configReloader = () => {
      const fresh = loadGlobalConfig({ fsFactory });
      if (isMotion) return resolveLLMConfig(fresh);
      const freshClawCfg = loadClawConfig({ fsFactory }, getClawConfigPath(clawId));
      return resolveLLMConfig(fresh, freshClawCfg!);
    };

    // --- Runtime 构造（deps 注入） ---
    let runtime: Runtime;
    try {
      runtime = createRuntime({
        identity: isMotion ? 'motion' : 'claw',
        clawId: isMotion ? MOTION_CLAW_ID : clawId,
        clawDir,
        llmConfig,
        maxSteps,
        toolProfile,
        idleTimeoutMs,
        configReloader,
        dependencies,
        contextTrimmingEnabled: true,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=runtime`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: Runtime construct failed: ${formatErr(e)}`, { cause: e });
    }

    // shadow tool — 依赖 Runtime.getCallerSnapshot（L4 turn state 快照）
    // 必须在 runtime 创建后注册，不能提前（runtime 尚未存在）
    mainRegistry.register(createShadowTool({
      getTurnSnapshot: () => runtime.getCallerSnapshot(),
      taskSystem,
      subagentMaxSteps: maxSteps,
      // phase 1865 (SH-D7)：默认执行策略由装配方注入（值来源 constants）
      defaultTimeoutMs: SHADOW_DEFAULT_TIMEOUT_MS,
    }));

    // Phase 1396 Step E: EventLoop 执行停滞恢复的 Assembly DI。
    // Phase 1840: 提醒链失败出口退役（不再适配 ContractSystem.failActiveForExecutor）；
    // probe 只读持久事实（stream LLM output / contract 创建时间 merge），EventLoop
    // 不直接持有 ContractSystem、不做 rename/cancel。
    const executionRecovery: EventLoopExecutionRecoveryDeps = {
      probeActivity: async () => {
        const active = listActiveContracts(systemFs, '.');
        // Phase 1841: active[0] 只选择本次观察对象（单个 claw 的提醒对象）；
        // 不授予清理其他记录的权利——未列出的契约不等于终态。
        const activeContractId = active[0]?.contractId;
        const streamMs = await readStreamExecutionActivityMs(systemFs, auditWriter);
        const createdMs = getActiveContractTimestamp(systemFs, '.', auditWriter);
        const lastActivityAt = streamMs !== null && createdMs !== null
          ? Math.max(streamMs, createdMs)
          : (streamMs ?? createdMs);
        return { activeContractId, lastActivityAt };
      },
      // phase 1863 (AT-D13)：语义 = 本进程是否有执行句柄（in-process 视图；磁盘 SoT 见 listRunning）。
      // phase 1869 (Step E 核证登记)：queued（磁盘 pending）**显式排除**——它是 dispatcher
      // 领取前的预派发态，唯一推进者 = startDispatch 调度循环（其启动失败则 Runtime.init
      // 抛错、EventLoop 不运行）；循环侧无法区分「瞬时排队」与「停滞」（watcher 漏事件 /
      // movePendingToRunning 失败重试），排除后停滞场景提醒照常触发；饱和排队必伴随
      // in-process>0（已被本事实覆盖）。磁盘 running 含崩溃残留（归 task-recovery），
      // 不作在途判据。核证用例：tests/core/async-task-system/queue-wait-facts.test.ts。
      isAsyncTaskInFlight: async () => taskSystem.getInProcessRunningCount() > 0,
    };

    return { snapshot, streamWriter, runtime, executionRecovery, recoverySession };
  } catch (e) {
    streamWriter.close();
    throw e;
  }
}
