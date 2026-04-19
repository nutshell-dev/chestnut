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
import { ClawRuntime, type ClawRuntimeOptions } from '../core/runtime.js';
import { MotionRuntime } from '../core/motion/runtime.js';
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

  // phase155A: 预制 fs 句柄，合并函数体内多处零散的 FileSystem 构造
  const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
  const parentFs = new NodeFileSystem({ baseDir: path.join(clawDir, '..'), enforcePermissions: false });

  // --- 1. AuditWriter (daemon.ts L100-104) ---
  let auditWriter: AuditWriter;
  try {
    auditWriter = new AuditWriter(clawFs, 'audit.tsv', auditMaxSizeMb);
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

  let runtime: MotionRuntime | ClawRuntime;
  try {
    runtime = isMotion
      ? new MotionRuntime({
          clawId: 'motion',
          clawDir,
          llmConfig,
          maxSteps: globalConfig.motion?.max_steps ?? DEFAULT_MAX_STEPS,
          toolProfile: 'full',
          toolTimeoutMs: globalConfig.tool_timeout_ms,
          subagentMaxSteps: globalConfig.motion?.subagent_max_steps,
          maxConcurrentTasks: globalConfig.motion?.max_concurrent_tasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
          idleTimeoutMs: globalConfig.motion?.llm_idle_timeout_ms,
          auditMaxSizeMb,
          auditWriter,
        })
      : new ClawRuntime({
          clawId,
          clawDir,
          llmConfig,
          maxSteps: clawConfig!.max_steps,
          toolProfile: clawConfig!.tool_profile,
          toolTimeoutMs: globalConfig.tool_timeout_ms,
          subagentMaxSteps: clawConfig!.subagent_max_steps,
          maxConcurrentTasks: clawConfig!.max_concurrent_tasks,
          idleTimeoutMs: globalConfig.motion?.llm_idle_timeout_ms,
          auditMaxSizeMb,
          auditWriter,
        } as ClawRuntimeOptions);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=runtime`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: Runtime construct failed: ${errMsg(e)}`, { cause: e });
  }

  // --- 4. Snapshot construct + init + recovery (daemon.ts L140-150) ---
  let snapshot: Snapshot;
  try {
    snapshot = createSnapshot(clawDir, clawFs, auditWriter, SNAPSHOT_IGNORE_PATTERNS);
  } catch (e) {
    auditWriter.write('assemble_failed', `module=snapshot`, `phase=construct`, `reason=${errMsg(e)}`);
    throw new Error(`Assembly: Snapshot construct failed: ${errMsg(e)}`, { cause: e });
  }

  const initResult = await snapshot.init();
  if (!initResult.ok) {
    // 契约 §4 drift 修正：init 失败抛 assemble_failed（原 daemon 代码静默继续）
    auditWriter.write('assemble_failed', `module=snapshot`, `phase=init`, `reason=${initResult.error.kind}`);
    throw new Error(`Assembly: Snapshot.init failed: ${initResult.error.kind}`);
  }

  const recoveryResult = await snapshot.commit('recovery-snapshot');
  if (!recoveryResult.ok) {
    // 契约 §4 软失败决策：recovery 失败不抛，audit 留痕（与当前代码一致）
    auditWriter.write('assemble_failed', `module=snapshot`, `phase=recovery-commit`, `reason=${recoveryResult.error.kind}`);
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
    streamWriter = createStreamWriter(clawFs, auditWriter, {
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
            fs: new NodeFileSystem({ baseDir: clawforumDir, enforcePermissions: false }),
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
            const cronFs = new NodeFileSystem({ baseDir: clawforumDir, enforcePermissions: false });
            await runDeepDream({
              clawforumDir,
              llmConfig,
              maxCompressionTokens: globalConfig.cron?.jobs?.dream_trigger?.max_compression_tokens,
              fs: cronFs,
            });
            await runRandomDream({
              clawforumDir,
              motionDir: clawDir,
              taskSystem: runtime.getTaskSystem(),
              fs: cronFs,
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
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
