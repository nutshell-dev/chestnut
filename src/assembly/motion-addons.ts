/**
 * @module L6.Assembly.MotionAddons
 * @layer L6 装配层
 *
 * assemble() SRP 子工厂：Motion-only 附加组件（Gateway + Heartbeat + CronRunner + MemorySystem）。
 * phase 34 Step D：从 assemble() 抽出步骤 16-17（motion-only addons）。
 */

import { resolveChestnutRoot } from '../foundation/install-paths.js';
import { CLAWS_DIR } from '../foundation/claw-paths.js';
import { AUDIT_FILE } from '../foundation/audit/index.js';
import path from 'path';
import { formatErr } from '../foundation/utils/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import { createHeartbeat, type Heartbeat } from '../core/runtime/index.js';
import type { Runtime } from '../core/runtime/index.js';
import { createCronRunner, type CronRunner } from '../core/cron/index.js';
import { createDiskMonitorJob } from '../core/cron/jobs/disk-monitor.js';
import { createLlmStatsJob } from '../core/cron/jobs/llm-stats.js';
import { createMetricsSnapshotJob } from '../core/cron/jobs/metrics-snapshot.js';
import { createGitGcWeeklyJob } from '../core/cron/jobs/git-gc-weekly.js';
import { createRetentionCleanupJob } from '../core/cron/jobs/retention-cleanup.js';
import { createAuditSizeMonitorJob } from '../core/cron/jobs/audit-size-monitor.js';
import { createDreamTriggerJob } from '../core/memory/jobs/dream-trigger.js';
import { createMemorySystem, memorySearchTool } from '../core/memory/index.js';
import type { MemorySystem } from '../core/memory/index.js';
import { createClawContractBridge } from '../core/memory/claw-contract-bridge.js';
import { createContractObserverJob } from '../core/contract/jobs/contract-observer.js';
import { createOutboxSummaryJob } from '../core/cron/jobs/outbox-summary/index.js';
import { createGateway } from '../core/gateway/index.js';
import type { Gateway } from '../core/gateway/index.js';
import { createAskUserTool } from '../core/gateway/index.js';
import { createStreamReader, STREAM_FILE, findRecentTurnStartOffset } from '../foundation/stream/index.js';
import { createNotifyClawTool } from '../foundation/messaging/tools/notify-claw.js';
import { formatClawStatusHint } from '../cli/commands/claw-shared.js';
import { notifyClaw, OutboxReader } from '../foundation/messaging/index.js';
import { MOTION_CLAW_ID, makeClawId } from '../constants.js';
import type { CoreInfraOutput } from './core-infrastructure.js';
import type { BusinessSysOutput } from './business-systems.js';
import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';
import type { AssembleConfig } from './types.js';

interface MotionAddonsInput {
  core: CoreInfraOutput;
  business: BusinessSysOutput;
  runtime: Runtime;
  config: AssembleConfig;
  streamWriter: StreamWriter;
}

interface MotionAddonsOutput {
  gateway?: Gateway;
  heartbeat?: Heartbeat;
  cronRunner?: CronRunner;
  disposeContractSystems?: () => Promise<void>;
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
  let disposeContractSystems: (() => Promise<void>) | undefined;

  // --- Gateway (motion only, offline mode) ---
  try {
    gateway = createGateway({
      streamFactory: (onEvent) => createStreamReader(systemFs, STREAM_FILE, onEvent, auditWriter),
      getInitialOffset: () => findRecentTurnStartOffset(systemFs, STREAM_FILE),
      transport: undefined,                      // offline mode (latent: future wire UnixDomainSocketTransport per phase 1055)
      interrupt: () => runtime.abort(),          // offline 不会触发，留接口
      audit: auditWriter,
    });
  } catch (e) {
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=gateway`, `phase=construct`, `reason=${formatErr(e)}`);
    throw new Error(`Assembly: Gateway construct failed: ${formatErr(e)}`, { cause: e });
  }
  // ask_user 工具：motion 启 / claw 不启（决策 #25：用户 ↔ motion ↔ claw 中介）
  toolRegistry.register(createAskUserTool(gateway));
  // notify_claw 工具：motion-only（D11 单向访问特权 / phase 477 design / phase 822 实施 / phase 1021 P0 三重错位 hotfix）
  // motion → claw inbox push、与 send（claw → 自己 outbox pull）物理不同、§10.3 不对称设计
  // fs = parentFs (baseDir = .chestnut/) align chestnutRoot、避免 systemFs (baseDir = motion/) 沙箱拒 sibling claws/<to> absolute path
  const chestnutRoot = resolveChestnutRoot(clawDir, true);  // phase 241: hoist for callbacks
  toolRegistry.register(createNotifyClawTool({
    fs: parentFs,
    chestnutRoot,  // phase 1406: motion-only context (motion clawDir = <root>/motion → root)
    audit: auditWriter,
    isClawAlive: (clawId: string) => core.processManager.isAlive(makeClawId(clawId)), // phase 232
    formatClawStatusHint, // phase 232: M#1 single source
    clawExists: (clawId: string) => parentFs.existsSync(path.join(CLAWS_DIR, clawId)), // phase 241
    hasActiveContract: (clawId: string) => { // phase 241
      try {
        const clawFs = fsFactory(path.join(chestnutRoot, CLAWS_DIR, clawId));
        const entries = clawFs.listSync(path.join('contract', 'active'), { includeDirs: true });
        return entries.some(e => e.isDirectory);
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
        notifyInbox: (msg) => notifyClaw(parentFs, chestnutRoot, MOTION_CLAW_ID, msg, auditWriter),
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=heartbeat`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: Heartbeat construct failed: ${formatErr(e)}`, { cause: e });
    }
  }

  // --- CronRunner (motion + cron.enabled, daemon.ts L187-248) ---
  if (globalConfig.cron.enabled) {
    const chestnutRoot = resolveChestnutRoot(clawDir, true);  // phase 1406: motion-only context (isMotion+cron guard)
    const tickMs = globalConfig.cron.tick_interval_ms;
    const diskLimitMB = globalConfig.watchdog.disk_warning_mb;

    // phase155D：预制 chestnutFs，被 disk-monitor / dream-trigger 闭包共用（冻结 §6）
    // 失败语义：与既有模块（Snapshot / StreamWriter）一致 —— audit 写 assemble_failed 后上抛
    let chestnutFs: import('../foundation/fs/types.js').FileSystem;
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
      const clawContractBridge = createClawContractBridge({
        fsFactory,
        clawTopology: core.topology,  // phase 259
        // phase 104: pre-bound notifyClaw
        notifyClaw: (targetClawId, message) =>
          notifyClaw(parentFs, chestnutRoot, targetClawId, message, auditWriter),
        llm,
        toolRegistry,
        toolTimeoutMs,
      });
      disposeContractSystems = async () => {
        await clawContractBridge.dispose();
      };

      try {
        memorySystem = createMemorySystem({
          clawTopology: core.topology,  // phase 259
          motionDir: clawDir,
          fs: chestnutFs,
          motionFs: systemFs,
          audit: auditWriter,
          taskSystem: runtime.getTaskSystem(),
          llmService: llm,
          llmConfig,
          maxCompressionTokens: globalConfig.cron.jobs.dream_trigger.max_compression_tokens,
          clawFsFactory: fsFactory,
          getContractProgress: clawContractBridge.getContractProgress,
          // phase 92: DI callback for random-dream notify motion inbox
          notifyMotion: (msg) => notifyClaw(parentFs, chestnutRoot, MOTION_CLAW_ID, msg, auditWriter),
        });
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=memory_system`, `phase=construct`, `reason=${formatErr(e)}`);
        throw new Error(`Assembly: MemorySystem construct failed: ${formatErr(e)}`, { cause: e });
      }
      toolRegistry.register(memorySearchTool);
    }

    // phase 8: diskMonitorInbox 移除 — disk + audit-size 警告改 viewport stream（移出 motion inbox / dev_warning subtype）

    try {
      const cronJobs = [
        createDiskMonitorJob({
          clawTopology: core.topology,  // phase 259
          limitMB: diskLimitMB,
          fs: chestnutFs,
          audit: auditWriter,
          motionAudit: auditWriter,  // phase 724 α：主 auditWriter 单 instance 复用
          streamLog: streamWriter,   // phase 8: viewport stream (取代 motionInbox)
        }, globalConfig),
        createLlmStatsJob({
          motionDir: clawDir,
          chestnutFs,
          motionFs: systemFs,
          clawTopology: core.topology,  // phase 259
          audit: auditWriter,
        }, globalConfig),
        createDreamTriggerJob({ memorySystem: memorySystem! }, globalConfig),
        createMetricsSnapshotJob({
          motionDir: path.join(chestnutRoot, 'motion'),
          fs: chestnutFs,
          audit: auditWriter,
        }, globalConfig),
        createContractObserverJob({
          clawTopology: core.topology,  // phase 259
          motionDir: path.join(chestnutRoot, 'motion'),  // phase 101
          fs: chestnutFs,
          motionAudit: auditWriter,  // phase 724 α：主 auditWriter 单 instance 复用
          notifyMotion: (msg) => notifyClaw(chestnutFs, chestnutRoot, MOTION_CLAW_ID, msg, auditWriter),
        }, globalConfig),
        createGitGcWeeklyJob({
          clawTopology: core.topology,  // phase 259
          fs: chestnutFs,
          audit: auditWriter,
        }, globalConfig),
        createRetentionCleanupJob({
          motionDir: clawDir,
          fs: chestnutFs,
          audit: auditWriter,
          maxDays: {
            inbox: globalConfig.retention.inbox_max_days,
            outbox: globalConfig.retention.outbox_max_days,
            tasks: globalConfig.retention.tasks_max_days,
            dialog: globalConfig.retention.dialog_max_days,
          },
        }, globalConfig),
        createAuditSizeMonitorJob({
          fs: chestnutFs,
          audit: auditWriter,
          motionAuditPath: path.join(chestnutRoot, 'motion', AUDIT_FILE),
          rootAuditPath: path.join(chestnutRoot, AUDIT_FILE),
          streamLog: streamWriter,   // phase 8: viewport stream (取代 motionInbox)
        }, globalConfig),
        createOutboxSummaryJob({
          clawTopology: core.topology,  // phase 259
          fs: chestnutFs,
          audit: auditWriter,
          inboxReader,
          inboxWriter: business.selfInbox,
          outboxReader: new OutboxReader(chestnutFs, auditWriter),
        }, globalConfig),
      ];
      cronRunner = createCronRunner(cronJobs, auditWriter);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: CronRunner construct failed: ${formatErr(e)}`, { cause: e });
    }

    try {
      cronRunner.start(tickMs);
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=start`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: CronRunner start failed: ${formatErr(e)}`, { cause: e });
    }
  }

  return { gateway, heartbeat, cronRunner, disposeContractSystems };
}
