import path from 'path';
import { formatErr } from '../foundation/utils/index.js';
import { resolveChestnutRoot } from '../foundation/install-paths.js';
// CLAWS_DIR removed: phase 263

import type { FileSystem } from '../foundation/fs/types.js';
import { NodeFileSystem } from '../foundation/fs/node-fs.js';

import { createSystemAudit, type AuditLog } from '../foundation/audit/index.js';
import { reconcileFallbackDumps } from '../foundation/audit/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import { createAgentProcessManager } from '../foundation/process-manager/agent-factory.js';
import { createLLMOrchestrator, type LLMOrchestrator } from '../foundation/llm-orchestrator/index.js';
import { createLLMAuditSink } from './llm-audit-sink.js';
import { buildLLMConfig } from './config-load.js';
import { createToolRegistry, type ToolRegistry } from '../foundation/tools/index.js';
import { createFileTools } from '../foundation/file-tool/index.js';
import { createCommandTools } from '../foundation/command-tool/index.js';
import { spawnTool } from '../core/spawn-system/index.js';
import { SummonTool, checkLegacySummonStateFiles } from '../core/summon-system/index.js';
import { createSkillSystem as defaultCreateSkillSystem, SkillSystem } from '../foundation/skill-system/index.js';
import { SKILLS_DIR_DEFAULT } from '../foundation/skill-system/index.js';
import { ContractSystem, createContractSystem } from '../core/contract/index.js';
import { makeClawId } from '../foundation/identity/index.js';
import { MOTION_CLAW_ID } from '../constants.js';
import type { ClawTopology } from '../core/claw-topology/index.js';
import { createOutboxWriter, type OutboxWriter, notifyClaw as notifyClawFn } from '../foundation/messaging/index.js';
import { TASKS_SYNC_DIR } from '../core/async-task-system/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import { AggregatedFileRouting } from './file-routing-aggregator.js';
import type { AssembleConfig } from './types.js';

export interface CoreInfraInput {
  config: AssembleConfig;
  lockState: { acquired: boolean };
  createSkillSystem?: typeof defaultCreateSkillSystem;
}

export interface CoreInfraOutput {
  fsFactory: (baseDir: string) => FileSystem;
  systemFs: FileSystem;
  clawFs: FileSystem;
  parentFs: FileSystem;
  auditWriter: AuditLog;
  processManager: ProcessManager;
  llmConfig: ReturnType<typeof buildLLMConfig>;
  llm: LLMOrchestrator;
  maxSteps: number | undefined;
  maxConcurrent: number;
  toolProfile: string;
  toolTimeoutMs: number;
  idleTimeoutMs: number;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillSystem;
  contractManager: ContractSystem;
  outboxWriter: OutboxWriter;
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
  const { config, lockState } = input;
  const { identity, clawId, clawDir, globalConfig, clawConfig } = config;
  const isMotion = identity === 'motion';
  const auditMaxSizeMb = globalConfig.audit.retention.max_size_mb;

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

  let processManager: ProcessManager | undefined;
  let auditWriter: AuditLog | undefined;
  let topology: ClawTopology | undefined;

  try {
    // --- 1. AuditWriter (daemon.ts L100-104) ---
    try {
      auditWriter = createSystemAudit(systemFs, clawDir, {
        typeToFile: AggregatedFileRouting,
        maxSizeMb: auditMaxSizeMb,
      });
    } catch (e) {
      throw new Error(`Assembly: audit writer construct failed: ${formatErr(e)}`, { cause: e });
    }

    // phase 281 Step B: scan legacy summon-state/ files and emit audit (no auto-delete)
    try {
      await checkLegacySummonStateFiles(systemFs, auditWriter);
    } catch (err) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.FALLBACK_RECONCILE_FAILED, `reason=${formatErr(err)}`);
    }

    // Reconcile prior crash fallback dumps after audit writer is ready
    try {
      await reconcileFallbackDumps(systemFs);
    } catch (err) {
      auditWriter.write(
        ASSEMBLY_AUDIT_EVENTS.FALLBACK_RECONCILE_FAILED,
        `reason=${formatErr(err)}`,
      );
    }

    // --- 2. ProcessManager + acquireLock (daemon.ts L107-108) ---
    try {
      processManager = createAgentProcessManager({ fsFactory }, auditWriter);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=process_manager`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: ProcessManager construct failed: ${formatErr(e)}`, { cause: e });
    }

    try {
      processManager.acquireLock(makeClawId(clawId));
      lockState.acquired = true;
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_LOCK_CONFLICT, `clawId=${clawId}`);
      throw e;
    }

    // --- 3. LLM Config / Orchestrator (daemon.ts L111-137 的 L3-L5 部分) ---
    let llmConfig: ReturnType<typeof buildLLMConfig>;
    try {
      llmConfig = isMotion
        ? buildLLMConfig(globalConfig)
        : buildLLMConfig(globalConfig, clawConfig!);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=llm_config`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: buildLLMConfig failed: ${formatErr(e)}`, { cause: e });
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

    let llm: LLMOrchestrator;
    try {
      const auditLog = auditWriter;
      llm = createLLMOrchestrator({
        ...llmConfig,
        primary: { ...llmConfig.primary, auditLog },
        fallbacks: llmConfig.fallbacks?.map((fb) => ({ ...fb, auditLog })),
        events: createLLMAuditSink(auditWriter),
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=llm`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: LLMOrchestrator construct failed: ${formatErr(e)}`, { cause: e });
    }

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

      toolRegistry.register(spawnTool);
      // shadowTool 改为 post-runtime 注册（需要 Runtime.getTurnSnapshot）

      // phase 257: wire ClawTopology（替换 read/ls/search via Map.set 同名替换）
      const { wireClawTopology } = await import('./wire-claw-topology.js');
      topology = wireClawTopology({
        fs: systemFs,
        chestnutRoot,
        audit: auditWriter,
        toolRegistry,
        motionClawId: MOTION_CLAW_ID,
      });

      // phase 1406: SummonTool 走标准注册路径（构造期 0 参 / accessesCaller=true /
      // shadow path 通过 ExecContext.getCallerSnapshot() 读 caller 深度态、
      // mining path 用 ctx.registry 取 miner profile 工具）。不再走 Runtime
      // initialize() 内反向 import + new + register「结构性循环依赖妥协」。
      // phase 281 Step B: SummonStateStore 已删；SummonTool 构造期 0 参。
      toolRegistry.register(new SummonTool());

      // phase378 后 exec 业务归 CommandTool L2 / 不再经 registerBuiltinTools / Assembly 显式注册
      const commandTools = createCommandTools();
      toolRegistry.register(commandTools.exec);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=tool_registry`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: ToolRegistry construct failed: ${formatErr(e)}`, { cause: e });
    }

    // --- L3-L5: skillRegistry (lazy init / phase 1053 α-6) ---
    let skillRegistry: SkillSystem;
    try {
      const createSkillFn = input.createSkillSystem ?? defaultCreateSkillSystem;
      skillRegistry = createSkillFn(systemFs, SKILLS_DIR_DEFAULT, auditWriter);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=skill_registry`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: SkillSystem construct failed: ${formatErr(e)}`, { cause: e });
    }

    // --- L3-L5: contractManager ---

    let contractManager: ContractSystem;
    try {
      // phase 324 H12: notifyClaw 跨 claw 落 inbox 时 join 出 <chestnutRoot>/claws/<other>/...
      // 绝对路径；旧码 bind systemFs (baseDir=clawDir)、resolveAndCheck 一律拒
      // PermissionError、外层 try/catch 静默吞 → 跨 claw 通知 0 落。
      // 改 bind 一个 chestnut-root-scoped fs、绝对路径在合法范围。
      const rootFs = fsFactory(chestnutRoot);
      contractManager = createContractSystem({
        clawDir, clawId: makeClawId(clawId), fs: systemFs, audit: auditWriter, llm,
        toolRegistry,   // phase 704: toolRegistry 注入 ContractSystem
        toolTimeoutMs,  // phase 1029 / F-2
        fsFactory,
        // phase 104: pre-bound notifyClaw (bind fs + chestnutRoot + audit)
        // phase 324 H12: fs 改用 rootFs（chestnut-root-scoped）让绝对 inbox 路径能落。
        notifyClaw: (targetClawId, message) =>
          notifyClawFn(rootFs, chestnutRoot, targetClawId, message, auditWriter!),
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_manager`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: ContractSystem construct failed: ${formatErr(e)}`, { cause: e });
    }
    try {
      await contractManager.init();
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=contract_manager`, `phase=init`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: ContractSystem.init failed: ${formatErr(e)}`, { cause: e });
    }

    // Phase 230 / phase 281 Step B: SummonVerifyPolicy 改在 business-systems.ts
    // 注册（依赖 AsyncTaskSystem 构造完成后才能提供 loadTask）。

    // --- L2: outboxWriter ---
    let outboxWriter: OutboxWriter;
    try {
      outboxWriter = createOutboxWriter(makeClawId(clawId), clawDir, systemFs, auditWriter);
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
      maxSteps,
      maxConcurrent,
      toolProfile,
      toolTimeoutMs,
      idleTimeoutMs,
      toolRegistry,
      skillRegistry,
      contractManager,
      outboxWriter,
      isMotion,
      chestnutRoot,
      clawDir,
      clawId,
      topology,
    };
  } catch (e) {
    if (lockState.acquired && processManager) {
      try {
        processManager.releaseLock(makeClawId(clawId));
        lockState.acquired = false;
      } catch (releaseErr) {
        auditWriter?.write(
          ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
          `module=lockfile_release`,
          `phase=assemble_throw_cleanup`,
          `reason=${formatErr(releaseErr)}`,
        );
      }
    }
    throw e;
  }
}
