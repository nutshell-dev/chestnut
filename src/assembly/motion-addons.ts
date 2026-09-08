/**
 * @module L6.Assembly.MotionAddons
 * @layer L6 装配层
 *
 * assemble() SRP 子工厂：Motion-only 附加组件（Gateway + Heartbeat + CronRunner + MemorySystem）。
 * phase 34 Step D：从 assemble() 抽出步骤 16-17（motion-only addons）。
 */

import { resolveChestnutRoot, routeNotifyClaw, routeNotifyClawAsync, getRelativeClawDir } from '../core/claw-topology/index.js';
import { AUDIT_FILE, AUDIT_PATHS, AUDIT_LEGACY_PATHS } from '../foundation/audit/index.js';
import { createSystemAudit } from '../foundation/audit/index.js';
import path from 'path';
import { formatErr } from '../foundation/node-utils/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import { createHeartbeat, createHeartbeatCursorStore, type Heartbeat } from '../core/heartbeat/index.js';
import type { Runtime } from '../core/runtime/index.js';
import { createCronRunner, parseSchedule, type CronJob, type CronRunner } from '../foundation/cron/index.js';
// phase 1242 Step A: AuditLog 只暴露 monitor capability；Assembly 负责 CronJob descriptor 组合
import { runAuditSizeMonitor, AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { createDreamTriggerJob } from '../core/memory/index.js';
import { createMemorySystem, memorySearchTool } from '../core/memory/index.js';
import type { MemorySystem } from '../core/memory/index.js';
import { createClawContractBridge } from '../core/memory/index.js';
import { createContractObserverJob } from '../core/contract/index.js';
import { createContractSystem, type ContractSystem } from '../core/contract/index.js';
import { createOutboxSummaryJob } from '../core/claw-topology/index.js';
import { createGateway } from '../core/gateway/index.js';
import type { Gateway } from '../core/gateway/index.js';
import { createStreamReader, STREAM_EVENT_NAMES, STREAM_FILE, findRecentTurnStartOffset } from '../foundation/stream/index.js';
import { createNotifyClawTool } from '../core/claw-topology/index.js';
import { formatClawStatusHint, renderCliGuidanceAction } from '../cli-protocol/index.js';
import { OutboxReader } from '../foundation/messaging/index.js';
import { hasActiveContract } from '../core/contract/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import type { CoreInfraOutput } from './core-infrastructure.js';
import type { BusinessSysOutput } from './business-systems.js';
import { closeBridgeContractSystems, type ContractBridgeDisposeResult } from './contract-bridge-dispose.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import { RETRO_AUDIT_EVENTS } from '../core/evolution-system/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../core/contract/index.js';
import type { AssembleConfig } from './types.js';
import type { ContractId } from '../core/contract/index.js';

interface MotionAddonsInput {
  core: CoreInfraOutput;
  business: BusinessSysOutput;
  runtime: Runtime;
  config: AssembleConfig;
  streamWriter: StreamWriter;
}

/** Phase 1242 Step A: Assembly-owned audit-size-monitor CronJob descriptor. */
export function createAuditSizeMonitorCronJob(
  deps: {
    fs: FileSystem;
    audit: Parameters<typeof runAuditSizeMonitor>[0]['audit'];
    primaryAuditPath: string;
    secondaryAuditPath: string;
    /** Phase 1288 Step D：legacy 根 audit.tsv 常驻观察（必填，与 monitor 收口一致）。 */
    legacyAuditPath: string;
    streamLog?: Parameters<typeof runAuditSizeMonitor>[0]['streamLog'];
    streamEventType?: string;
  },
  globalConfig: { cron: { jobs: { audit_size_monitor: { enabled: boolean; schedule: string } } } },
): CronJob {
  return {
    name: 'audit-size-monitor',
    enabled: globalConfig.cron.jobs.audit_size_monitor.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.audit_size_monitor.schedule, deps.audit),
    handler: (signal) => runAuditSizeMonitor({ ...deps, signal }),
    timeoutMs: AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS,
  } satisfies CronJob;
}

interface MotionAddonsOutput {
  gateway?: Gateway;
  heartbeat?: Heartbeat;
  cronRunner?: CronRunner;
  // phase 1808 Step B: typed dispose outcome（close 失败证据可观察）
  disposeContractSystems?: () => Promise<ContractBridgeDisposeResult>;
}

export async function createMotionAddons(
  input: MotionAddonsInput,
): Promise<MotionAddonsOutput> {
  const { core, business, runtime, config, streamWriter } = input;
  const { clawDir, globalConfig } = config;
  const {
    systemFs, parentFs, auditWriter,
    llmConfig, llm,
    toolTimeoutMs,
    toolRegistry, fsFactory,
  } = core;
  const { inboxReader } = business;

  let gateway: Gateway | undefined;
  let heartbeat: Heartbeat | undefined;
  let cronRunner: CronRunner | undefined;
  let disposeContractSystems: (() => Promise<ContractBridgeDisposeResult>) | undefined;

  // --- Gateway (motion only, offline mode) ---
  // phase 1445 Step D（裁定②）：start 内化进 createGateway 工厂（工厂变 async）；
  // start 失败由工厂抛错、本 catch 载荷不变（phase=start）。
  try {
    gateway = await createGateway({
      streamFactory: (onEvent) => createStreamReader(systemFs, STREAM_FILE, onEvent, auditWriter),
      getInitialOffset: () => findRecentTurnStartOffset(systemFs, STREAM_FILE),
      transport: undefined,                      // offline mode (latent: future wire UnixDomainSocketTransport per phase 1055)
      interrupt: () => runtime.abort(),          // offline 不会触发，留接口
      audit: auditWriter,
    });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=gateway`, `phase=start`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: Gateway start failed: ${formatErr(e)}`, { cause: e });
  }
  // notify_claw 工具：motion-only（D11 单向访问特权 / phase 477 design / phase 822 实施 / phase 1021 P0 三重错位 hotfix）
  // motion → claw inbox push、与 send（claw → 自己 outbox pull）物理不同、§10.3 不对称设计
  // fs = parentFs (baseDir = .chestnut/) align chestnutRoot、避免 systemFs (baseDir = motion/) 沙箱拒 sibling claws/<to> absolute path
  const chestnutRoot = resolveChestnutRoot(clawDir, true);  // phase 241: hoist for callbacks
  toolRegistry.register(createNotifyClawTool({
    fs: parentFs,
    notifyClaw: async (targetClawId, message) =>
      routeNotifyClawAsync(parentFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, message, auditWriter),
    defaultSource: MOTION_CLAW_ID,
    authorized: true,
    audit: auditWriter,
    isClawAlive: (clawId: string) => core.processManager.isAlive(resolveClawDaemonDir(makeClawId(clawId))), // phase 232
    formatClawStatusHint, // phase 232: M#1 single source
    clawExists: (clawId: string) => parentFs.existsSync(getRelativeClawDir(clawId)), // phase 241
    hasActiveContract: (clawId: string) => { // phase 241
      try {
        const clawFs = fsFactory(path.join(chestnutRoot, getRelativeClawDir(clawId)));
        return hasActiveContract(clawFs, '.');
      } catch {
        return false;
      }
    },
  }));


  // --- Heartbeat (motion + interval > 0, daemon.ts L158-169) ---
  const heartbeatIntervalMs = globalConfig.motion.heartbeat_interval_ms;
  if (heartbeatIntervalMs > 0) {
    try {
      // phase 84: DI callback - L6 装配期 bind chestnutRoot + MOTION_CLAW_ID + notifyClaw
      heartbeat = createHeartbeat({  // phase 1406: motion-only context
        interval: heartbeatIntervalMs / 1000,
        audit: auditWriter,
        inboxReader,
        notifyInbox: (msg) => routeNotifyClaw(parentFs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, msg, auditWriter),
        // phase 1791: Heartbeat-owned 单 cursor 文件（motion claw 根），装配期注入路径
        cursorStore: createHeartbeatCursorStore(systemFs, 'heartbeat-cursor.json'),
      });
      // phase 1791: 显式恢复点 —— 重启后从 cursor 重建 due 基线；恢复状态必须显式处理
      const cursorRead = await heartbeat.initialize();
      if (cursorRead.kind === 'malformed' || cursorRead.kind === 'unavailable') {
        // Heartbeat 已 audit CURSOR_DEGRADED（stage/error 保留）；安全策略 = 从 now
        // 重建等满 interval，装配期降级继续（不阻塞 daemon 启动、不重复 audit）。
      }
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=heartbeat`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: Heartbeat construct failed: ${formatErr(e)}`, { cause: e });
    }
  }

  // --- CronRunner (motion + cron.enabled, daemon.ts L187-248) ---
  if (globalConfig.cron.enabled) {
    const chestnutRoot = resolveChestnutRoot(clawDir, true);  // phase 1406: motion-only context (isMotion+cron guard)
    const tickMs = globalConfig.cron.tick_interval_ms;

    // phase155D：预制 chestnutFs，被 dream-trigger 闭包共用（冻结 §6）
    // 失败语义：与既有模块（Snapshot / StreamWriter）一致 —— audit 写 assemble_failed 后上抛
    let chestnutFs: import('../foundation/fs/index.js').FileSystem;
    try {
      chestnutFs = fsFactory(chestnutRoot);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=fs_construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: chestnutFs construct failed: ${formatErr(e)}`, { cause: e });
    }

    // --- MemorySystem (L5, motion only) ---
    let memorySystem: MemorySystem | undefined;
    {
      // M#3: random-dream 读取 contract progress 走 ContractSystem API（phase 1104）
      // phase 1807 Step B（MEMORY-CONTRACT-BRIDGE-OVERWIDE-ADAPTER）：Memory 只注入
      // 窄 ContractProgressReader capability——per-claw ContractSystem 的构造、缓存
      // 与 close 生命周期全部收口在装配层，不再泄漏 LLM/ToolRegistry/notifyClaw 给
      // Memory。
      // phase 1808 Step B：条目携带 clawId identity，close 失败可按 claw 归因
      const bridgeContractSystems: { clawId: string; cs: ContractSystem }[] = [];
      const clawContractBridge = createClawContractBridge({
        clawTopology: core.topology,  // phase 259
        createReader: async (targetClawId, targetClawDir) => {
          const cFs = fsFactory(targetClawDir);
          const cAudit = createSystemAudit(cFs, targetClawDir);
          // phase 1445 Step D：只读 getProgress 用途、故意不传 bootReconcile（不 init）
          const cs = await createContractSystem({
            clawDir: targetClawDir,
            clawId: targetClawId,
            fs: cFs,
            audit: cAudit,
            llm,
            toolRegistry,
            toolTimeoutMs,
            fsFactory,
            // phase 104: pre-bound notifyClaw
            notifyClaw: (notifyTarget, message) =>
              routeNotifyClaw(parentFs, chestnutRoot, MOTION_CLAW_ID, notifyTarget, message, auditWriter),
          });
          bridgeContractSystems.push({ clawId: targetClawId, cs });
          return { getProgress: (id) => cs.getProgress(id) };
        },
      });
      disposeContractSystems = async (): Promise<ContractBridgeDisposeResult> => {
        // phase 517 B8: allSettled 兜底、单个 close 失败不阻其他（原 bridge.dispose
        // 语义上移装配层）；bridge.dispose() 只清 capability 缓存引用。
        // phase 1808 Step B（MEMORY-CONTRACT-BRIDGE-DISPOSE-FAILURE-SILENT）：close
        // 结果 typed outcome 显式返回，逐条失败携带 clawId 与原始 error，不再静默。
        await clawContractBridge.dispose();
        return closeBridgeContractSystems(bridgeContractSystems);
      };

      try {
        memorySystem = createMemorySystem({
          clawTopology: core.topology,  // phase 259
          motionDir: clawDir,
          fs: chestnutFs,
          motionFs: systemFs,
          audit: auditWriter,
          taskSystem: business.taskSystem,
          llmService: llm,
          llmConfig,
          maxCompressionTokens: globalConfig.cron.jobs.dream_trigger.max_compression_tokens,
          clawFsFactory: fsFactory,
          getContractProgress: clawContractBridge.getContractProgress,
          // phase 92 / phase 1159 Step C: DI callback for random-dream notify motion inbox (fail-loud async)
          notifyMotion: (msg) => routeNotifyClawAsync(parentFs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, msg, auditWriter),
          // phase 1162 Step C: DI callback for deep-dream notify target claw inbox (fail-loud async)
          notifyClaw: (targetClawId, msg) =>
            routeNotifyClawAsync(parentFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, msg, auditWriter),
        });
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=memory_system`, `phase=construct`, `reason=${formatErr(e)}`);
        throw new Error(`Assembly: MemorySystem construct failed: ${formatErr(e)}`, { cause: e });
      }
      toolRegistry.register(memorySearchTool);
    }

    try {
      const cronJobs = [
        createDreamTriggerJob({ memorySystem: memorySystem! }, globalConfig),
        createContractObserverJob({
          clawTopology: core.topology,  // phase 259
          motionDir: path.join(chestnutRoot, 'motion'),  // phase 101
          fs: chestnutFs,
          motionAudit: auditWriter,  // phase 724 α：主 auditWriter 单 instance 复用
          notifyMotion: (msg) => routeNotifyClawAsync(chestnutFs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, msg, auditWriter),
          // Phase 1396 Step M：observer at-least-once 完成事实 → EvolutionSystem.observeContractCompleted
          // （幂等 v2 work item ensure + 自行 dispatch/recover），不再经过 notifyContractCompleted
          onCompletedContract: business.evolutionSystem && business.motionReviewContext
            ? async (clawId, contractId) => {
                try {
                  const result = await business.evolutionSystem!.observeContractCompleted(
                    { contractId: contractId as ContractId, executorId: makeClawId(clawId) },
                    business.motionReviewContext!,
                  );
                  auditWriter.write(
                    RETRO_AUDIT_EVENTS.RETRO_TRIGGERED,
                    `contractId=${contractId}`,
                    `source=contract_observer`,
                    `status=${result.status}`,
                  );
                } catch (e) {
                  auditWriter.write(
                    CONTRACT_AUDIT_EVENTS.CONTRACT_COMPLETED_HANDLER_FAILED,
                    `contractId=${contractId}`,
                    `source=contract_observer`,
                    `reason=${formatErr(e)}`,
                  );
                  throw e;
                }
              }
            : undefined,
        }, globalConfig),
        createAuditSizeMonitorCronJob({
          fs: chestnutFs,
          audit: auditWriter,
          primaryAuditPath: path.join(chestnutRoot, 'motion', AUDIT_FILE),
          // Phase 1288 Step D: 根审计三段常驻观察收口 —— 新写入只进 audit/audit.tsv
          // （secondary）；legacy 根 audit.tsv 原样保留、只读观察（清退属后续 Phase）
          secondaryAuditPath: path.join(chestnutRoot, AUDIT_PATHS.audit),
          legacyAuditPath: path.join(chestnutRoot, AUDIT_LEGACY_PATHS.audit),
          streamLog: streamWriter,   // phase 8: viewport stream (取代 motionInbox)
          streamEventType: STREAM_EVENT_NAMES.SYSTEM_NOTIFY,
        }, globalConfig),
        createOutboxSummaryJob({
          clawTopology: core.topology,  // phase 259
          fs: chestnutFs,
          audit: auditWriter,
          inboxReader,
          inboxWriter: business.selfInbox,
          outboxReader: new OutboxReader(chestnutFs, auditWriter),
          // phase 1757 Step B: 重复推送 skip 指引的最终 CLI invocation 在 L6 边界
          // 渲染 —— core 只见中性 RenderOutboxSkipHint callback port、零 cli-protocol。
          renderOutboxSkipHint: (clawId) =>
            renderCliGuidanceAction({ kind: 'claw.outbox-skip', target: { kind: 'claw', id: clawId } }),
        }, globalConfig),
      ];
      // phase 1445 Step D（裁定②）：start 内化进 createCronRunner 工厂、tickMs 经工厂参数传入；
      // start 失败由工厂抛错、并入本 catch（phase=construct、reason 含 start 错消息）。
      cronRunner = createCronRunner(cronJobs, auditWriter, tickMs);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: CronRunner construct failed: ${formatErr(e)}`, { cause: e });
    }
  }

  return { gateway, heartbeat, cronRunner, disposeContractSystems };
}
