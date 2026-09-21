import path from 'path';
import { formatErr } from '../foundation/node-utils/index.js';
import { resolveChestnutRoot } from '../foundation/claw-identity/index.js';
// CLAWS_DIR removed: phase 263

import type { FileSystem } from '../foundation/fs/index.js';
import { NodeFileSystem } from '../foundation/fs/index.js';

import { createSystemAudit, readWorkspaceAuditRetentionMaxSizeMb, type AuditLog } from '../foundation/audit/index.js';
import { reconcileFallbackDumps } from '../foundation/audit/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import { createAgentProcessManager } from '../foundation/process-manager/index.js';
import { createLLMOrchestrator, createRecoverySession, type LLMOrchestrator, type LLMOrchestratorOwner, type LLMRecoverySession } from '../foundation/llm-orchestrator/index.js';
import { createLLMEventSink } from './llm-event-sink.js';
import { resolveLLMConfig } from './config/config-load.js';
import { createStreamWriter } from '../foundation/stream/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import { createToolRegistry, type ToolRegistry } from '../foundation/tools/index.js';
import { createFileTools } from '../foundation/file-tool/index.js';
import { createCommandTools } from '../foundation/command-tool/index.js';
import { createAntiSelfKillGuard } from './anti-self-kill.js';
import { createSummonCreationClaimStore, restoreSummonFacts } from '../core/summon-system/index.js';
import { createSkillSystem as defaultCreateSkillSystem, SkillSystem, SkillSystemInitialLoadError } from '../foundation/skill-system/index.js';
import { SKILLS_DIR_DEFAULT } from '../foundation/skill-system/index.js';
import { ContractSystem, ContractAuditor, createContractSystem } from '../core/contract/index.js';
import { createContractNotificationAdapter } from './contract-notification-adapter.js';
import { InboxWriter, makeInboxPath, INBOX_PENDING_DIR } from '../foundation/messaging/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import type { ClawTopology } from '../core/claw-topology/index.js';
import { createOutboxWriter, type MessagingWriterLimits, type OutboxWriter } from '../foundation/messaging/index.js';
import { makeClawNotifyTargetResolver } from '../core/claw-topology/index.js';
import { createClawNotifier } from '../foundation/messaging/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import { createAggregatedFileRouting } from './file-routing-aggregator.js';
import { initializeClawLayout } from './claw-subdirs.js';
import { createAssemblyRollback } from './rollback.js';
import type { AssembleConfig, AssemblyContributions } from './types.js';

/** Phase 1826: 前台 LLM 恢复 session 的稳定 opaque scope 标识。 */
export const FOREGROUND_RECOVERY_SCOPE = 'foreground' as const;

interface CoreInfraInput {
  config: AssembleConfig;
  createSkillSystem?: typeof defaultCreateSkillSystem;
  /** phase 1243 Step B: external production contributions（audit file routing 等） */
  contributions?: AssemblyContributions;
}

export interface CoreInfraOutput {
  fsFactory: (baseDir: string) => FileSystem;
  systemFs: FileSystem;
  clawFs: FileSystem;
  parentFs: FileSystem;
  auditWriter: AuditLog;
  processManager: ProcessManager;
  llmConfig: ReturnType<typeof resolveLLMConfig>;
  llm: LLMOrchestrator;
  /** Phase 1826: 前台恢复 session（Runtime 用 session.llm，EventLoop 用调度面）。 */
  recoverySession: LLMRecoverySession;
  maxSteps: number | undefined;
  maxConcurrent: number;
  toolProfile: string;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillSystem;
  contractManager: ContractSystem;
  outboxWriter: OutboxWriter;
  /** phase 1820: messaging writer wire-size 上限（globalConfig.messaging 注入，供 business-systems 的 inbox writer 复用） */
  messagingLimits: MessagingWriterLimits;
  streamWriter: StreamWriter;
  isMotion: boolean;
  chestnutRoot: string;
  clawDir: string;
  clawId: string;
  topology: ClawTopology;
}

/**
 * @module L6.Assembly.CoreInfrastructure
 * @layer L6 装配层
 * @consumers L6.Assembly.assemble
 *
 * Assemble 子工厂 — 步骤 1-8：FileSystem → AuditWriter → ProcessManager → LLM → ToolRegistry → SkillSystem → ContractSystem → OutboxWriter。
 *
 * 抽出动机：assemble() M#1/SRP 治理（assembly-auditor §六.1 follow-up）。
 */
export async function createCoreInfrastructure(input: CoreInfraInput): Promise<CoreInfraOutput> {
  const { config } = input;
  const { identity, clawId, clawDir, globalConfig, clawConfig } = config;
  const isMotion = identity === 'motion';

  // phase155A + B + C 联合约定：system 组件无权限校验；工具层强制权限校验
  // systemFs: used by AuditWriter / Snapshot / DialogStore / Skill/Contract/Outbox/Inbox/Task/Context/Stream
  const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });
  // Phase 1288 Step B: retention SoT = AuditLog 自家 config store（.chestnut/audit/config.yaml）；
  // missing → null（与旧 root schema default 行为等价、不静默创建）；invalid → throw（fail-loud）。
  const auditMaxSizeMb = readWorkspaceAuditRetentionMaxSizeMb(fsFactory(resolveChestnutRoot(clawDir, isMotion)));
  const systemFs = fsFactory(clawDir);
  // phase 1368: claw 实例化 layout 是 Assembly-owned action；在任何业务模块构造前
  // 一次性创建/自愈，Runtime 不观察目录集合。
  initializeClawLayout(systemFs);
  // clawFs: used by tools via ExecContextImpl.fs
  // phase430: PermissionChecker removed from NodeFileSystem ctor;
  // claw-space boundary is enforced by L4 caller (tools) autonomy.
  const clawFs = fsFactory(clawDir);
  const parentFs = fsFactory(path.join(clawDir, '..'));

  let processManager: ProcessManager | undefined;
  let auditWriter: AuditLog | undefined;
  let topology: ClawTopology | undefined;

  // phase 1872 Step C: 内部自清注册表——「部分子资源已构造、后续失败」时反序 teardown，
  // 保持本工厂不返回半成品的契约（签名不变）。次生失败经 audit 留证；audit 尚不可用
  // （最早期的失败）时降级 stderr。
  const rollback = createAssemblyRollback((step, error) => {
    if (auditWriter) {
      try {
        auditWriter.write(
          ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
          `module=rollback`,
          `step=${step}`,
          `reason=${formatErr(error)}`,
        );
        return;
      } catch {
        // silent: audit 写入失败 → 降级 stderr 兜底（次生失败信息不丢，见下一行）。
      }
    }
    process.stderr.write(`[assembly] rollback teardown failed step=${step}: ${formatErr(error)}\n`);
  });

  try {
    // --- 1. AuditWriter (daemon.ts L100-104) ---
    try {
      auditWriter = createSystemAudit(systemFs, clawDir, {
        typeToFile: createAggregatedFileRouting(input.contributions?.auditFileRouting),
        maxSizeMb: auditMaxSizeMb,
      });
    } catch (e) {
      throw new Error(`Assembly: audit writer construct failed: ${formatErr(e)}`, { cause: e });
    }
    rollback.register('audit_writer', () => auditWriter?.dispose?.());

    // phase 281 Step B: scan legacy summon-state/ files and emit audit (no auto-delete)
    try {
      // phase 1866 Step H（SU-D8）：恢复事实经唯一入口（legacy 扫描子面在其内、audit 行为不变）。
      await restoreSummonFacts({
        fs: systemFs,
        audit: auditWriter,
        claimStore: createSummonCreationClaimStore({
          fs: fsFactory(resolveChestnutRoot(clawDir, isMotion)),
        }),
      });
    } catch (err) {
      // phase 703: 加 context col 区分 2 caller 路径、与 phase 582/584 context col 同模式
      auditWriter.write(
        ASSEMBLY_AUDIT_EVENTS.FALLBACK_RECONCILE_FAILED,
        `context=legacy_summon_state`,
        `reason=${formatErr(err)}`,
      );
    }

    // Reconcile prior crash fallback dumps after audit writer is ready
    try {
      await reconcileFallbackDumps(systemFs);
    } catch (err) {
      // phase 703: 加 context col 区分 2 caller 路径
      auditWriter.write(
        ASSEMBLY_AUDIT_EVENTS.FALLBACK_RECONCILE_FAILED,
        `context=crash_fallback_dumps`,
        `reason=${formatErr(err)}`,
      );
    }

    // --- 2. ProcessManager (daemon.ts L107-108) ---
    // Phase 1204 Step C: lifecycle lock 删除；child 凭显式 generation identity 在
    // daemon.ts 激活 generation，Assembly 不再 acquireLock。
    try {
      processManager = createAgentProcessManager({ fsFactory, baseDir: resolveChestnutRoot(clawDir, isMotion) }, auditWriter);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=process_manager`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: ProcessManager construct failed: ${formatErr(e)}`, { cause: e });
    }

    // --- 3. LLM Config / Orchestrator (daemon.ts L111-137 的 L3-L5 部分) ---
    let llmConfig: ReturnType<typeof resolveLLMConfig>;
    try {
      llmConfig = isMotion
        ? resolveLLMConfig(globalConfig)
        : resolveLLMConfig(globalConfig, clawConfig!);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=llm_config`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: resolveLLMConfig failed: ${formatErr(e)}`, { cause: e });
    }

    // --- L3-L5: 派生配置统一求值（motion vs claw 分叉） ---
    // phase 1485: 不再在 assembly 层 fallback DEFAULT_MAX_STEPS — undefined 直传 Runtime、
    // runReact 内部持有唯一 fallback（agent-executor 自持默认值）。
    const globalDefaultMaxSteps = globalConfig.default_max_steps;
    const maxSteps: number | undefined = isMotion
      ? (globalConfig.motion.max_steps ?? globalDefaultMaxSteps)
      : (clawConfig!.max_steps ?? globalDefaultMaxSteps);
    const maxConcurrent = isMotion
      ? globalConfig.motion.max_concurrent_tasks
      : clawConfig!.max_concurrent_tasks;
    const toolProfile = isMotion ? 'full' : clawConfig!.tool_profile;
    const toolTimeoutMs = globalConfig.tool_timeout_ms;
    const idleTimeoutMs = globalConfig.motion.llm_idle_timeout_ms;

    // --- L2b StreamWriter: construct early (no open) so LLMOrchestrator events can fan out ---
    let streamWriter: StreamWriter;
    try {
      streamWriter = createStreamWriter(systemFs, auditWriter, {
        maxFiles: globalConfig.stream.retention.max_files,
        maxDays: globalConfig.stream.retention.max_days,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=stream_writer`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: StreamWriter construct failed: ${formatErr(e)}`, { cause: e });
    }
    rollback.register('stream_writer', () => streamWriter.close());

    let llm: LLMOrchestratorOwner;
    let recoverySession: LLMRecoverySession;
    try {
      const auditLog = auditWriter;
      const llmEvents = createLLMEventSink(auditWriter, streamWriter);
      llm = createLLMOrchestrator({
        ...llmConfig,
        primary: { ...llmConfig.primary, auditLog },
        fallbacks: llmConfig.fallbacks?.map((fb) => ({ ...fb, auditLog })),
        events: llmEvents,
      });
      // Phase 1826: 前台恢复 session。原 orchestrator 仍供子代理/其他业务使用；
      // session.llm 是同一 owner 的范围视图（前台 Runtime 用），调度面给 EventLoop。
      // 状态不可用时构造即抛错（拒绝启动、保留原文），不猜默认值继续发请求。
      recoverySession = createRecoverySession({
        scopeId: FOREGROUND_RECOVERY_SCOPE,
        fs: systemFs,
        events: llmEvents,
        orchestrator: llm,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=llm`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: LLMOrchestrator construct failed: ${formatErr(e)}`, { cause: e });
    }
    rollback.register('llm', () => llm.close());

    // phase 1406: 单一 truth source（提前到 toolRegistry 装配前供 wireClawTopology 使用）
    const chestnutRoot = resolveChestnutRoot(clawDir, isMotion);

    // --- L3-L5: toolRegistry（空；SummonTool 留给 Runtime） ---
    let toolRegistry: ToolRegistry;
    try {
      toolRegistry = createToolRegistry();

      // phase428 FileTool 抽出 → foundation/file-tool/ / Assembly 显式注册
      // phase1006: permissionChecker 改由 ExecContext 注入，createFileTools 无需 factory
      for (const tool of createFileTools()) {
        toolRegistry.register(tool);
      }

      // shadowTool 改为 post-runtime 注册（需要 Runtime.getTurnSnapshot）

      // phase 257: wire ClawTopology（替换 read/ls/search via Map.set 同名替换）
      const { wireClawTopology } = await import('./wire-claw-topology.js');
      const { createCrossTargetAccess } = await import('./cross-target-access.js');
      topology = wireClawTopology({
        fs: parentFs,
        chestnutRoot,
        audit: auditWriter,
        toolRegistry,
        isMotion,
        // phase 1864 Step G（CT-D10）：跨目标 capa 装配期授予（motion / claw 面主体）。
        crossTargetAccess: createCrossTargetAccess({
          grantedBy: isMotion ? 'motion-cross-target' : 'claw-cross-target',
          audit: auditWriter,
        }),
      });

      // phase378 后 exec 业务归 CommandTool L2 / 不再经 registerBuiltinTools / Assembly 显式注册
      // phase758: motion-chain self-kill guard 由 L6 Assembly 注入
      const commandTools = createCommandTools(isMotion ? createAntiSelfKillGuard() : undefined);
      toolRegistry.register(commandTools.exec);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=tool_registry`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: ToolRegistry construct failed: ${formatErr(e)}`, { cause: e });
    }

    // --- L3-L5: skillRegistry (phase 1872 Step G: 首载归 owner 工厂内完成) ---
    let skillRegistry: SkillSystem;
    try {
      const createSkillFn = input.createSkillSystem ?? defaultCreateSkillSystem;
      // 工厂内完成首载（构造完成即 registry 非空；phase 1070 动机保持）；
      // 首载失败为 owner 类型化错误——Assembly 只分类留证、不解释加载内部。
      skillRegistry = await createSkillFn(systemFs, SKILLS_DIR_DEFAULT, auditWriter);
    } catch (e) {
      const phase = e instanceof SkillSystemInitialLoadError ? 'initialize' : 'construct';
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=skill_system`, `phase=${phase}`, `reason=${formatErr(e)}`);
      // owner 错误原样上抛（类型可辨、cause 链不丢）。
      throw e;
    }

    // --- L3-L5: contractManager ---

    // phase 1820: messaging writer wire-size 上限由配置 owner（globalConfig.messaging）
    // 装配期注入；writer 不再读 env、不持默认值。limits 同时挂 output 供 business-systems 复用。
    // phase 1872 Step F: 提前到 contractManager 之前（auditor 的 inbox writer 消费）。
    const messagingLimits: MessagingWriterLimits = {
      bodyMaxBytes: globalConfig.messaging.body_max_bytes,
    };

    let contractManager: ContractSystem;
    try {
      // phase 324 H12: notifyClaw 跨 claw 落 inbox 时 join 出 <chestnutRoot>/claws/<other>/...
      // 绝对路径；旧码 bind systemFs (baseDir=clawDir)、resolveAndCheck 一律拒
      // PermissionError、外层 try/catch 静默吞 → 跨 claw 通知 0 落。
      // 改 bind 一个 chestnut-root-scoped fs、绝对路径在合法范围。
      const rootFs = fsFactory(chestnutRoot);
      // phase 1864 Step C（CT-D2）：发送归 Messaging；位置经拓扑 resolver 注入。
      const clawNotifier = createClawNotifier({
        fs: rootFs,
        audit: auditWriter!,
        resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
      });
      // phase 1872 Step F: onNotify sink / auditor 一次固定——装配期构造参数注入
      // （原 runtime-assembly setOnNotify / business-systems attachAuditor 后补依赖退役）。
      const selfInboxDir = path.join(clawDir, INBOX_PENDING_DIR);
      const contractNotificationSink = createContractNotificationAdapter({
        streamWriter,
        clawId,
        systemFs,
        selfInboxDir,
        auditWriter,
      });
      // auditor 保持 fail-soft：构造失败 audit 留证、不阻断装配（原语义）。
      let auditor: ContractAuditor | undefined;
      try {
        const clawInbox = InboxWriter.__internal_create(
          systemFs,
          makeInboxPath(selfInboxDir),
          auditWriter,
          messagingLimits,
        );
        auditor = new ContractAuditor({ audit: auditWriter, fs: systemFs, inbox: clawInbox, llm });
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_auditor`, `phase=construct`, `reason=${formatErr(e)}`);
      }
      // phase 1445 Step D（裁定②例外）：bootReconcile 经工厂参数传入、init 内化进工厂；
      // init 失败由工厂抛错、并入本 catch（phase=construct）。旁路调用点（CLI/watchdog/
      // bridge/summonQuery）不传 bootReconcile、保持不 init（详 manager.ts deps 注释）。
      contractManager = await createContractSystem({
        clawDir, clawId: makeClawId(clawId), fs: systemFs, audit: auditWriter, llm,
        toolRegistry,   // phase 704: toolRegistry 注入 ContractSystem
        toolTimeoutMs,  // phase 1029 / F-2
        fsFactory,
        bootReconcile: true,
        onNotify: contractNotificationSink,
        auditor,
        // phase 104: pre-bound notifyClaw (bind fs + chestnutRoot + audit)
        // phase 324 H12: fs 改用 rootFs（chestnut-root-scoped）让绝对 inbox 路径能落。
        notifyClaw: (targetClawId, message) => clawNotifier.notify(targetClawId, message),
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_manager`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: ContractSystem construct failed: ${formatErr(e)}`, { cause: e });
    }
    rollback.register('contract_manager', () => contractManager.close());

    // Phase 230 / phase 281 Step B: SummonVerifyPolicy 改在 business-systems.ts
    // 注册（依赖 AsyncTaskSystem 构造完成后才能提供 loadTask）。

    // --- L2: outboxWriter ---
    let outboxWriter: OutboxWriter;
    try {
      outboxWriter = createOutboxWriter(makeClawId(clawId), clawDir, systemFs, auditWriter, messagingLimits);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=outbox_writer`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: OutboxWriter construct failed: ${formatErr(e)}`, { cause: e });
    }

    return {
      fsFactory,
      systemFs,
      clawFs,
      parentFs,
      auditWriter,
      processManager,
      llmConfig,
      llm,
      recoverySession,
      maxSteps,
      maxConcurrent,
      toolProfile,
      toolTimeoutMs,
      idleTimeoutMs,
      toolRegistry,
      skillRegistry,
      contractManager,
      outboxWriter,
      messagingLimits,
      streamWriter,
      isMotion,
      chestnutRoot,
      clawDir,
      clawId,
      topology,
    };
  } catch (e) {
    // phase 1872 Step C: 内部自清——已构造子资源反序 teardown（次生失败 audit/stderr
    // 留证），本工厂不返回半成品；原 error 原样重抛（cause 链不丢）。
    await rollback.run();
    throw e;
  }
}
