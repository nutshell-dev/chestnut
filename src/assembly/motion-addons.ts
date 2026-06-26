/**
 * @module L6.Assembly.MotionAddons
 * @layer L6 装配层
 *
 * assemble() SRP 子工厂：Motion-only 附加组件（Gateway + Heartbeat + CronRunner + MemorySystem）。
 * phase 34 Step D：从 assemble() 抽出步骤 16-17（motion-only addons）。
 */

import { resolveChestnutRoot, routeNotifyClaw, getRelativeClawDir } from '../core/claw-topology/index.js';
import { AUDIT_FILE } from '../foundation/audit/index.js';
import path from 'path';
import { formatErr } from '../foundation/node-utils/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import { createHeartbeat, type Heartbeat } from '../core/runtime/index.js';
import type { Runtime } from '../core/runtime/index.js';
import { createCronRunner, type CronRunner } from '../foundation/cron/index.js';
// phase 697 Step B: audit-size-monitor 迁 foundation/audit/jobs/ (audit module sister 归属)
import { createAuditSizeMonitorJob } from '../foundation/audit/jobs/audit-size-monitor.js';
import { createDreamTriggerJob } from '../core/memory/jobs/dream-trigger.js';
import { createMemorySystem, memorySearchTool } from '../core/memory/index.js';
import type { MemorySystem } from '../core/memory/index.js';
import { createClawContractBridge } from '../core/memory/claw-contract-bridge.js';
import { createContractObserverJob } from '../core/contract/jobs/contract-observer.js';
import { createOutboxSummaryJob } from '../core/claw-topology/jobs/outbox-summary/index.js';
import { createGateway } from '../core/gateway/index.js';
import type { Gateway } from '../core/gateway/index.js';
import { createAskUserTool } from '../core/gateway/index.js';
import { createStreamReader, STREAM_FILE, findRecentTurnStartOffset } from '../foundation/stream/index.js';
import { createNotifyClawTool } from '../foundation/messaging/tools/notify-claw.js';
import { formatClawStatusHint } from '../cli/utils/claw-status-hints.js';
import { OutboxReader } from '../foundation/messaging/index.js';
import { hasActiveContract } from '../core/contract/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
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
    notifyClaw: (targetClawId, message) =>
      routeNotifyClaw(parentFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, message, auditWriter),
    defaultSource: MOTION_CLAW_ID,
    isCallerAuthorized: (label) => label === MOTION_CLAW_ID,
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
      const clawContractBridge = createClawContractBridge({
        fsFactory,
        clawTopology: core.topology,  // phase 259
        // phase 104: pre-bound notifyClaw
        notifyClaw: (targetClawId, message) =>
          routeNotifyClaw(parentFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, message, auditWriter),
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
          notifyMotion: (msg) => routeNotifyClaw(parentFs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, msg, auditWriter),
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
          notifyMotion: (msg) => routeNotifyClaw(chestnutFs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, msg, auditWriter),
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
