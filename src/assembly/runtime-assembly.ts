/**
 * @module L6.Assembly.RuntimeAssembly
 * @layer L6 装配层
 *
 * assemble() SRP 子工厂：Snapshot + StreamWriter + Runtime 构造与装配。
 * phase 34 Step C：从 assemble() 抽出步骤 12-15（Snapshot → StreamWriter → Runtime → shadowTool）。
 */

// resolveChestnutRoot and CLAWS_DIR removed: phase 263
import path from 'path';
import { formatErr } from '../foundation/utils/index.js';
import { createSnapshot } from '../foundation/snapshot/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from '../foundation/snapshot/index.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import { createStreamWriter } from '../foundation/stream/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import { type Runtime, type RuntimeDependencies } from '../core/runtime/index.js';
import { createRuntime } from '../core/runtime/index.js';
import { createContractNotifyCallback } from './contract-notify-callback.js';
import type { CoreInfraOutput } from './core-infrastructure.js';
import type { BusinessSysOutput } from './business-systems.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
// phase 320: LLM hot-reload — reloader 每次调时重读磁盘
import { loadGlobalConfig, loadClawConfig, buildLLMConfig } from './config-load.js';
import { getClawConfigPath } from '../foundation/config/index.js';
import { TASKS_SYNC_EXEC_DIR } from '../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../foundation/file-tool/index.js';
import { createShadowTool } from '../core/shadow-system/index.js';
import { MOTION_CLAW_ID } from '../constants.js';
import { CLAW_SUBDIRS } from './claw-subdirs.js';
import type { AssembleConfig } from './types.js';

/** phase 440：默认被过滤的 systemSubtype（claw_outbox_summary / heartbeat / claw_inactivity） */
const DEFAULT_FILTER_SUBTYPES: ReadonlySet<string> = new Set([
  'claw_outbox_summary',
  'heartbeat',
  'claw_inactivity',
]);

interface RuntimeAssemblyInput {
  core: CoreInfraOutput;
  business: BusinessSysOutput;
  config: AssembleConfig;
}

interface RuntimeAssemblyOutput {
  snapshot: Snapshot;
  streamWriter: StreamWriter;
  runtime: Runtime;
}

export async function createRuntimeAssembly(
  input: RuntimeAssemblyInput,
): Promise<RuntimeAssemblyOutput> {
  const { core, business, config } = input;
  const { clawDir, globalConfig, identity, clawId } = config;
  const isMotion = identity === 'motion';
  const {
    systemFs, auditWriter, llm, llmConfig,
    maxSteps, toolProfile, idleTimeoutMs,
    toolRegistry, skillRegistry, contractManager, fsFactory, outboxWriter,
  } = core;
  const {
    taskSystem, permissionChecker, sessionManager, makeDialogStore,
    inboxReader, formatterRegistry, guidanceRegistry,
    selfInboxDir,
  } = business;

  // --- Snapshot（phase155B 已搬，但需保证在 Runtime 之前） ---
  let snapshot: Snapshot;
  try {
    snapshot = createSnapshot(clawDir, systemFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS, [
      path.join(clawDir, TASKS_SYNC_EXEC_DIR),
      path.join(clawDir, TASKS_SYNC_WRITE_DIR),
    ]);
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=snapshot`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: Snapshot construct failed: ${formatErr(e)}`, { cause: e });
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
      maxFiles: globalConfig.stream.retention.max_files,
      maxDays: globalConfig.stream.retention.max_days,
    });
    streamWriter.open();
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=stream_writer`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: StreamWriter construct failed: ${formatErr(e)}`, { cause: e });
  }

  try {
    // contractNotify callback 在 Runtime 构造前形成（注入 deps 而非 setter）
    const contractNotifyCallback = createContractNotifyCallback({
      streamWriter,
      clawId,
      systemFs,
      selfInboxDir,
      auditWriter,
    });

    // === RuntimeDependencies 分组构造（assembly-auditor §六.5 follow-up / 可读性） ===
    const messagingDeps = {
      inboxReader,
      outboxWriter,
      parentStreamLog: streamWriter,
    };

    const toolingDeps = {
      toolRegistry,
      toolExecutor: business.toolExecutor,
      skillRegistry,
      formatterRegistry,
      // phase 27 Step D P5: guidance compose callback hook（motion-only / claw 装配 undefined）
      guidanceCompose: guidanceRegistry
        ? (type: string, state: Record<string, string>) => guidanceRegistry.compose(type, state) ?? null
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
      llm,
      contractManager,
      taskSystem,
      permissionChecker,  // NEW phase 1273 / 复用 line 287 既有构造
      contractNotifyCallback,
      // phase 521: regime switch coordination / Assembly own factory / closure capture 5 const
      dialogStoreFactory: makeDialogStore,
      // phase 69: L6 Assembly 装配期注入 claw 子目录列表
      clawSubdirs: CLAW_SUBDIRS,
      ...messagingDeps,
      ...toolingDeps,
      ...lifecycleDeps,
    };

    // phase 320: configReloader — 每次调时重读磁盘 globalConfig + clawConfig，
    // 由 Runtime._drainOwnInbox 收到 reload_llm_config 消息时调用。
    // **不 capture 起步态 globalConfig/clawConfig**（CLOSURE 反模式：那样永远拿不到新配置）。
    const configReloader = () => {
      const fresh = loadGlobalConfig({ fsFactory });
      if (isMotion) return buildLLMConfig(fresh);
      const freshClawCfg = loadClawConfig({ fsFactory }, getClawConfigPath(clawId));
      return buildLLMConfig(fresh, freshClawCfg!);
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
        contextManagerConfig: {
          filterSubtypes: DEFAULT_FILTER_SUBTYPES,
        },
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=runtime`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: Runtime construct failed: ${formatErr(e)}`, { cause: e });
    }

    // shadow tool — 依赖 Runtime.getCallerSnapshot（L4 turn state 快照）
    // 必须在 runtime 创建后注册，不能提前（runtime 尚未存在）
    toolRegistry.register(createShadowTool({
      getTurnSnapshot: () => runtime.getCallerSnapshot(),
    }));

    return { snapshot, streamWriter, runtime };
  } catch (e) {
    streamWriter.close();
    throw e;
  }
}
