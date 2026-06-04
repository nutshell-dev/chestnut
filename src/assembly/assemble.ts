import path from 'path';
import { formatErr } from '../foundation/utils/index.js';

import type { FileSystem } from '../foundation/fs/types.js';

import type { AuditLog } from '../foundation/audit/index.js';
import { createSnapshot } from '../foundation/snapshot/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from './snapshot-patterns.js';
import type { Snapshot } from '../foundation/snapshot/index.js';
import { createStreamWriter } from '../foundation/stream/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';

import { isFileNotFound } from '../foundation/fs/types.js';



import { type Runtime, type RuntimeDependencies } from '../core/runtime/index.js';
import { createRuntime } from '../core/runtime/index.js';
import { createContractNotifyCallback } from './contract-notify-callback.js';
import type { CoreInfraOutput } from './core-infrastructure.js';

import { ASSEMBLY_AUDIT_EVENTS } from './audit-events.js';

import { TASKS_SYNC_EXEC_DIR } from '../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../foundation/file-tool/index.js';






import { createShadowTool } from '../core/shadow-system/index.js';
import { cleanupOrphanedTemp } from './cleanup.js';
import { notifyClaw } from '../foundation/messaging/index.js';


import { createNotifyClawTool } from '../foundation/messaging/tools/notify-claw.js';


import { createHeartbeat, type Heartbeat } from '../core/runtime/index.js';
import { createCronRunner, CronRunner } from '../core/cron/index.js';
import { createDiskMonitorJob } from '../core/cron/jobs/disk-monitor.js';
import { createLlmStatsJob } from '../core/cron/jobs/llm-stats.js';
import { createMetricsSnapshotJob } from '../core/cron/jobs/metrics-snapshot.js';
import { createGitGcWeeklyJob } from '../core/cron/jobs/git-gc-weekly.js';
import { createRetentionCleanupJob } from '../core/cron/jobs/retention-cleanup.js';
import { createAuditSizeMonitorJob } from '../core/cron/jobs/audit-size-monitor.js';
import { createDreamTriggerJob } from '../core/cron/jobs/dream-trigger.js';
// phase 6: sunset-monitor cron 砍 — sunset_ready 不归 motion 决策 / 改 dev-side 手动查 audit.tsv 直接 grep LEGACY_*
import { createMemorySystem, memorySearchTool } from '../core/memory/index.js';
import type { MemorySystem } from '../core/memory/index.js';
import { createClawContractBridge } from '../core/memory/claw-contract-bridge.js';
import { createContractObserverJob } from '../core/contract/jobs/contract-observer.js';
// phase 1476: outbox-drain cron 砍 — pull 模型替 push（详 design/modules/l5_cron.md A.phase1476-outbox-summary-cron-job）
import { createOutboxSummaryJob } from '../core/cron/jobs/outbox-summary.js';


import type { AssembleConfig, Instances } from './types.js';
import { createCoreInfrastructure } from './core-infrastructure.js';
import { createBusinessSystems } from './business-systems.js';
import { createGateway } from '../core/gateway/index.js';
import type { Gateway } from '../core/gateway/index.js';
import { createAskUserTool } from '../core/gateway/index.js';
import { createStreamReader, STREAM_FILE, findRecentTurnStartOffset } from '../foundation/stream/index.js';

import { resolveChestnutRoot, makeClawDir } from '../foundation/identity/index.js';
import { MOTION_CLAW_ID } from '../constants.js';


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
      const message = formatErr(err);
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

  const lockState = { acquired: false };
  let core: CoreInfraOutput | undefined;

  let streamWriter: StreamWriter | undefined;
  // Phase 1200: contractSystemCache dispose hook (motion lifecycle end-of-life)
  let disposeContractSystems: (() => Promise<void>) | undefined;

  try {
    core = await createCoreInfrastructure({ config, lockState });
    const {
      fsFactory, systemFs, parentFs,
      auditWriter, processManager,
      llmConfig, llm,
      maxSteps, toolProfile, toolTimeoutMs, idleTimeoutMs,
      toolRegistry, skillRegistry, contractManager, outboxWriter,
    } = core;

    // A.6 motionInboxDir 提前到 taskSystem / callback 定义前（双链路保险 / cron job 注册块同步引用）
    const business = await createBusinessSystems({ core });
    const {
      taskSystem, evolutionSystem,
      permissionChecker, motionInboxDir,
      toolExecutor, sessionManager, makeDialogStore,
      inboxReader, formatterRegistry, guidanceRegistry,
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

    // contractNotify callback 在 Runtime 构造前形成（注入 deps 而非 setter）
    const contractNotifyCallback = createContractNotifyCallback({
      streamWriter: streamWriter!,
      clawId,
      systemFs,
      motionInboxDir,
      auditWriter,
    });

    // === RuntimeDependencies 分组构造（assembly-auditor §六.5 follow-up / 可读性） ===
    const messagingDeps = {
      inboxReader,
      outboxWriter,
      parentStreamLog: streamWriter!,
    };

    const toolingDeps = {
      toolRegistry,
      toolExecutor,
      skillRegistry,
      formatterRegistry,
      // phase 27 Step D P5: guidance compose callback hook（motion-only / claw 装配 undefined）
      guidanceCompose: (type: string, state: Record<string, string>) => guidanceRegistry?.compose(type, state) ?? null,
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
      ...messagingDeps,
      ...toolingDeps,
      ...lifecycleDeps,
    };

    // 孤儿临时文件清理（从 Runtime.initialize 搬来；Assembly 负责一次性的启动清理）
    cleanupOrphanedTemp(systemFs, clawDir).catch((err: unknown) => {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.CLEANUP_TEMP_FILES_FAILED, `reason=${formatErr(err)}`);
    });

    // --- Runtime 构造（deps 注入） ---
    let runtime: Runtime;
    try {
      runtime = createRuntime({
        identity: isMotion ? 'motion' : 'claw',
        clawId: isMotion ? MOTION_CLAW_ID : clawId,
        clawDir,
        chestnutRoot: resolveChestnutRoot(clawDir, isMotion),  // phase 1406: 单一 truth source
        llmConfig,
        maxSteps,
        toolProfile,

        idleTimeoutMs,
        dependencies,
      });
    } catch (e) {
      auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=runtime`, `phase=construct`, `reason=${formatErr(e)}`);
      throw new Error(`Assembly: Runtime construct failed: ${formatErr(e)}`, { cause: e });
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
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=gateway`, `phase=construct`, `reason=${formatErr(e)}`);
        throw new Error(`Assembly: Gateway construct failed: ${formatErr(e)}`, { cause: e });
      }
      // ask_user 工具：motion 启 / claw 不启（决策 #25：用户 ↔ motion ↔ claw 中介）
      toolRegistry.register(createAskUserTool(gateway));
      // notify_claw 工具：motion-only（D11 单向访问特权 / phase 477 design / phase 822 实施 / phase 1021 P0 三重错位 hotfix）
      // motion → claw inbox push、与 send（claw → 自己 outbox pull）物理不同、§10.3 不对称设计
      // fs = parentFs (baseDir = .chestnut/) align chestnutRoot、避免 systemFs (baseDir = motion/) 沙箱拒 sibling claws/<to> absolute path
      toolRegistry.register(createNotifyClawTool({
        fs: parentFs,
        chestnutRoot: resolveChestnutRoot(clawDir, true),  // phase 1406: motion-only context (motion clawDir = <root>/motion → root)
        audit: auditWriter,
      }));
    }

    // --- 5. detectUncleanExit (daemon.ts L152) ---
    detectUncleanExit(clawDir, auditWriter, systemFs);

    // --- 6. Heartbeat (motion + interval > 0, daemon.ts L158-169) ---
    let heartbeat: Heartbeat | undefined;
    if (isMotion) {
      const heartbeatIntervalMs = globalConfig.motion.heartbeat_interval_ms;
      if (heartbeatIntervalMs > 0) {
        try {
          heartbeat = createHeartbeat(resolveChestnutRoot(clawDir, true), {  // phase 1406: motion-only context
            interval: heartbeatIntervalMs / 1000,
            fs: parentFs,
            audit: auditWriter,
            inboxReader,
          });
        } catch (e) {
          auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=heartbeat`, `phase=construct`, `reason=${formatErr(e)}`);
          throw new Error(`Assembly: Heartbeat construct failed: ${formatErr(e)}`, { cause: e });
        }
      }
    }

    // --- 7. CronRunner (motion + cron.enabled, daemon.ts L187-248) ---
    let cronRunner: CronRunner | undefined;
    if (isMotion && globalConfig.cron.enabled) {
      const chestnutRoot = resolveChestnutRoot(clawDir, true);  // phase 1406: motion-only context (isMotion+cron guard)
      const tickMs = globalConfig.cron.tick_interval_ms;
      const diskLimitMB = globalConfig.watchdog.disk_warning_mb;

      // phase155D：预制 chestnutFs，被 disk-monitor / dream-trigger 闭包共用（冻结 §6）
      // 失败语义：与既有模块（Snapshot / StreamWriter）一致 —— audit 写 assemble_failed 后上抛
      let chestnutFs: FileSystem;
      try {
        chestnutFs = fsFactory(chestnutRoot);
      } catch (e) {
        auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=cron_runner`, `phase=fs_construct`, `reason=${formatErr(e)}`);
        throw new Error(`Assembly: chestnutFs construct failed: ${formatErr(e)}`, { cause: e });
      }

      // --- MemorySystem (L5, motion only) ---
      let memorySystem: MemorySystem | undefined;
      if (isMotion) {
        // M#3: random-dream 读取 contract progress 走 ContractSystem API（phase 1104）
        const clawContractBridge = createClawContractBridge({
          fsFactory,
          chestnutRoot,
          llm,
          toolRegistry,
          toolTimeoutMs,
        });
        disposeContractSystems = async () => {
          await clawContractBridge.dispose();
        };

        try {
          memorySystem = createMemorySystem({
            chestnutRoot,
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
            chestnutRoot,
            limitMB: diskLimitMB,
            fs: chestnutFs,
            audit: auditWriter,
            motionAudit: auditWriter,  // phase 724 α：主 auditWriter 单 instance 复用
            streamLog: streamWriter!,   // phase 8: viewport stream (取代 motionInbox)
          }, globalConfig),
          createLlmStatsJob({
            chestnutRoot,
            motionDir: clawDir,
            chestnutFs,
            motionFs: systemFs,
            audit: auditWriter,
          }, globalConfig),
          createDreamTriggerJob({ memorySystem: memorySystem! }, globalConfig),
          createMetricsSnapshotJob({
            motionDir: makeClawDir(path.join(chestnutRoot, 'motion')),
            fs: chestnutFs,
            audit: auditWriter,
          }, globalConfig),
          createContractObserverJob({
            chestnutRoot,
            fs: chestnutFs,
            motionAudit: auditWriter,  // phase 724 α：主 auditWriter 单 instance 复用
            notifyClaw: (fs, chestnutRoot, targetClawId, payload, audit) => notifyClaw(fs, chestnutRoot, targetClawId, payload, audit),
          }, globalConfig),
          createGitGcWeeklyJob({
            chestnutRoot,
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
            chestnutRoot,
            motionAuditPath: path.join(chestnutRoot, 'motion', 'audit.tsv'),
            rootAuditPath: path.join(chestnutRoot, 'audit.tsv'),
            streamLog: streamWriter!,   // phase 8: viewport stream (取代 motionInbox)
          }, globalConfig),
          createOutboxSummaryJob({
            chestnutRoot,
            fs: chestnutFs,
            audit: auditWriter,
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
    };
  } catch (e) {
    // Best-effort cleanup of already-constructed resources
    streamWriter?.close?.();
    core?.llm?.close()?.catch(() => {
      // silent: assemble throw 兜底 teardown 路径，原 error e 在末尾 throw 不丢失；llm.close 异步失败属次生 error，无 auditWriter 可信通道（catch 内 auditWriter 自身可能未完成构造）
    });
    if (lockState.acquired && core) {
      try {
        core.processManager.releaseLock(clawId);
      } catch (releaseErr) {
        core.auditWriter.write(
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


