/**
 * daemon command - main daemon entry point
 *
 * Supports foreground execution (CLAWFORUM_DAEMON_MODE) and automatic background launch via CLI
 * Responsible for starting ClawRuntime and keeping it running until SIGTERM is received
 */

import * as path from 'path';
import * as fsNative from 'fs';
import * as fsAsync from 'fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { AuditWriter } from '../../foundation/audit/writer.js';
import { ClawRuntime } from '../../core/runtime.js';
import { MotionRuntime } from '../../core/motion/runtime.js';
import { buildLLMConfig, loadGlobalConfig, loadClawConfig, getClawDir, getMotionDir } from '../config.js';
import type { ClawRuntimeOptions } from '../../core/runtime.js';
import type { InboxMessageInfo } from '../../core/runtime.js';
import { startDaemonLoop } from './daemon-loop.js';
import { StreamWriter } from '../../foundation/stream/writer.js';
import { Heartbeat } from '../../core/heartbeat.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { SkillRegistry } from '../../core/skill/registry.js';
import { ContractManager } from '../../core/contract/manager.js';
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_CONCURRENT_TASKS } from '../../constants.js';
import { scheduleSubAgentWithTracking } from '../../core/tools/builtins/spawn.js';
import type { Message } from '../../types/message.js';
import { buildRetroPrompt } from '../../prompts/index.js';
import { CronRunner, parseSchedule } from '../../core/cron/runner.js';
import { runDiskMonitor } from '../../core/cron/jobs/disk-monitor.js';
import { runLlmStats } from '../../core/cron/jobs/llm-stats.js';
import { runDeepDream } from '../../core/cron/jobs/deep-dream.js';
import { runRandomDream } from '../../core/cron/jobs/random-dream.js';
import { CliError } from '../errors.js';
import { initAgentGit, commitAgentDir } from '../../foundation/git/agent-git.js';



/**
 * 守护进程主函数（支持 claw 和 motion）
 */
export async function daemonCommand(name: string): Promise<void> {
  const globalConfig = loadGlobalConfig();
  const isMotion = name === 'motion';

  // 配置
  const dir = isMotion ? getMotionDir() : getClawDir(name);
  
  // lockfile 单实例保护
  const statusDir = path.join(dir, 'status');
  fsNative.mkdirSync(statusDir, { recursive: true });
  const lockFile = path.join(statusDir, 'daemon.lock');
  const pidFile = path.join(statusDir, 'pid');
  
  // 尝试获取排他锁
  try {
    const fd = fsNative.openSync(lockFile, 'wx');
    try {
      fsNative.writeFileSync(fd, String(process.pid));
    } finally {
      fsNative.closeSync(fd);
    }
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // lockfile 存在 → 检查持有者是否存活
      try {
        const lockPid = parseInt(fsNative.readFileSync(lockFile, 'utf-8').trim(), 10);
        process.kill(lockPid, 0); // 存活
        throw new CliError(`[daemon] Another ${name} daemon is running (PID: ${lockPid}), exiting`);
      } catch (killErr: any) {
        if (killErr instanceof CliError) throw killErr;
        // 持有者已死，删除 stale lock 并重试（ENOENT = 已被别人删，同样继续）
        try { fsNative.unlinkSync(lockFile); } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }
        const fd = fsNative.openSync(lockFile, 'wx');
        try {
          fsNative.writeFileSync(fd, String(process.pid));
        } finally {
          fsNative.closeSync(fd);
        }
      }
    } else {
      throw err;
    }
  }
  
  // 写 PID 文件（兜底：无论启动方式都确保 PID 可查）
  fsNative.writeFileSync(pidFile, String(process.pid));
  
  const clawConfig = isMotion ? null : loadClawConfig(name);
  const llmConfig = isMotion
    ? buildLLMConfig(globalConfig)
    : buildLLMConfig(globalConfig, clawConfig!);

  // 审计日志配置
  const auditMaxSizeMb = globalConfig.audit?.retention?.max_size_mb ?? null;

  // Runtime
  const runtime = isMotion
    ? new MotionRuntime({
        clawId: 'motion',
        clawDir: dir,
        llmConfig,
        maxSteps: globalConfig.motion?.max_steps ?? DEFAULT_MAX_STEPS,
        toolProfile: 'full',
        toolTimeoutMs: globalConfig.tool_timeout_ms,
        subagentMaxSteps: globalConfig.motion?.subagent_max_steps,
        maxConcurrentTasks: globalConfig.motion?.max_concurrent_tasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
        idleTimeoutMs: globalConfig.motion?.llm_idle_timeout_ms,
        auditMaxSizeMb,
      })
    : new ClawRuntime({
        clawId: name,
        clawDir: dir,
        llmConfig,
        maxSteps: clawConfig!.max_steps,
        toolProfile: clawConfig!.tool_profile,
        toolTimeoutMs: globalConfig.tool_timeout_ms,
        subagentMaxSteps: clawConfig!.subagent_max_steps,
        maxConcurrentTasks: clawConfig!.max_concurrent_tasks,
        idleTimeoutMs: globalConfig.motion?.llm_idle_timeout_ms,
        auditMaxSizeMb,
      } as ClawRuntimeOptions);

  // git init（claw 首次启动时无 .git，motion init 已处理 motion 的情况）
  await initAgentGit(dir);

  // recovery-snapshot：将上次中断遗留的 working tree 变更固化（在 session repair 之前）
  await commitAgentDir(dir, 'recovery-snapshot');

  await runtime.initialize();
  await runtime.resumeContractIfPaused();

  // motion 专属：heartbeat（0 表示禁用）
  let heartbeat: Heartbeat | null = null;
  if (isMotion) {
    const heartbeatIntervalMs = globalConfig.motion?.heartbeat_interval_ms ?? 0;
    if (heartbeatIntervalMs > 0) {
      heartbeat = new Heartbeat(path.join(dir, '..'), {
        interval: heartbeatIntervalMs / 1000  // 转换为秒
      });
    }
  }

  // 共用核心循环
  const streamFs = new NodeFileSystem({ baseDir: dir, enforcePermissions: false });
  const streamWriter = new StreamWriter(streamFs, {
    maxFiles: globalConfig.stream?.retention?.max_files ?? null,
    maxDays: globalConfig.stream?.retention?.max_days ?? null,
  });
  streamWriter.open();
  runtime.setParentStreamWriter(streamWriter);

  // motion 专属：cron 调度器
  let cronRunner: CronRunner | null = null;
  if (isMotion && (globalConfig.cron?.enabled ?? true)) {
    const tickMs = globalConfig.cron?.tick_interval_ms ?? 1000;
    const clawforumDir = path.join(dir, '..');  // motion/ 的上级即 .clawforum/
    const diskLimitMB = globalConfig.watchdog?.disk_warning_mb ?? 500;
    const diskScheduleStr = globalConfig.cron?.jobs?.disk_monitor?.schedule ?? 'hourly';

    cronRunner = new CronRunner([
      {
        name: 'disk-monitor',
        enabled: globalConfig.cron?.jobs?.disk_monitor?.enabled ?? true,
        schedule: parseSchedule(diskScheduleStr),
        handler: () => runDiskMonitor({
          clawforumDir,
          motionInboxDir: path.join(dir, 'inbox', 'pending'),
          limitMB: diskLimitMB,
        }),
      },
      {
        name: 'llm-stats',
        enabled: globalConfig.cron?.jobs?.llm_stats?.enabled ?? true,
        schedule: parseSchedule(globalConfig.cron?.jobs?.llm_stats?.schedule ?? 'daily:06:00'),
        handler: () => runLlmStats({
          clawforumDir,
          motionDir: dir,
        }),
      },
      {
        name: 'dream-trigger',
        enabled: globalConfig.cron?.jobs?.dream_trigger?.enabled ?? false,
        schedule: parseSchedule(globalConfig.cron?.jobs?.dream_trigger?.schedule ?? 'daily:04:00'),
        handler: async () => {
          // 深度梦境：串行处理每个 claw
          await runDeepDream({
            clawforumDir,
            llmConfig,
            maxCompressionTokens: globalConfig.cron?.jobs?.dream_trigger?.max_compression_tokens,
          });
          // 随机梦境：sub-agent 跨 claw 漫游
          await runRandomDream({
            clawforumDir,
            motionDir: dir,
            taskSystem: runtime.getTaskSystem(),
            streamWriter,
          });
        },
      },
    ]);
    cronRunner.start(tickMs);
  }

  // 清理残留心跳（上次 daemon 的遗留，重启后无需立即巡查）
  try {
    const pendingDir = path.join(dir, 'inbox', 'pending');
    const files = fsNative.readdirSync(pendingDir);
    for (const f of files) {
      if (f.includes('_heartbeat_')) {
        fsNative.unlinkSync(path.join(pendingDir, f));
      }
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn(`[daemon] Failed to clean up heartbeat files: ${e?.message}`);
    }
  }

  // daemon_start: 计算 AGENTS.md 的 sha256 前 6 位作为 system prompt 版本标识
  const auditWriter = runtime.getAuditWriter();

  // 检测上次是否非正常退出（SIGKILL / OOM 等无法写 daemon_crash 的情况）
  function detectUncleanExit(): void {
    const auditPath = path.join(dir, 'audit.tsv');
    if (!fsNative.existsSync(auditPath)) return;
    try {
      const stat = fsNative.statSync(auditPath);
      if (stat.size === 0) return;
      const chunkSize = 4096;
      const offset = Math.max(0, stat.size - chunkSize);
      const fd = fsNative.openSync(auditPath, 'r');
      const buf = Buffer.alloc(Math.min(chunkSize, stat.size));
      fsNative.readSync(fd, buf, 0, buf.length, offset);
      fsNative.closeSync(fd);
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
    } catch {
      // 读取失败不影响启动
    }
  }
  detectUncleanExit();

  let promptHash = 'n/a';
  try {
    const agentsContent = fsNative.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
    promptHash = createHash('sha256').update(agentsContent).digest('hex').slice(0, 6);
  } catch { /* AGENTS.md 不存在时跳过 */ }
  auditWriter.write('daemon_start', `sha256:${promptHash}`);

  // daemon-start commit（fire-and-forget，不阻塞启动）
  commitAgentDir(dir, `daemon-start ${new Date().toISOString()}`).catch(() => {});

  runtime.setContractNotifyCallback((type, data) => {
    streamWriter.write({ ts: Date.now(), type: 'user_notify', subtype: type, ...data });
  });
  const inboxPendingDir = path.join(dir, 'inbox', 'pending');

  // 注册 review_request 处理器（仅 motion）
  const onInboxMessages = isMotion
    ? async (infos: InboxMessageInfo[]) => {
        for (const { meta } of infos) {
          if (meta.type !== 'review_request') continue;
          const contractId = meta.contract_id;
          if (!contractId) continue;

          // 查 by-contract 反向索引（Step 5 写入的新格式）
          const byContractPath = path.join(
            dir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`,
          );
          let targetClaw: string | null = null;
          let mode: string | undefined;
          let miningTaskId: string | undefined;
          try {
            const fileContent = await fsAsync.readFile(byContractPath, 'utf-8');
            let raw: unknown;
            try {
              raw = JSON.parse(fileContent);
            } catch {
              console.warn('[daemon] by-contract index is not valid JSON, skipping retrospective:', contractId);
              continue;
            }
            if (typeof raw !== 'object' || raw === null) {
              console.warn('[daemon] by-contract index has unexpected format, skipping retrospective:', contractId);
              continue;
            }
            const r = raw as Record<string, unknown>;
            const rawTarget = typeof r.targetClaw === 'string' ? r.targetClaw : null;
            if (!rawTarget || !/^[a-z0-9-]+$/.test(rawTarget)) {
              console.warn('[daemon] by-contract index has invalid targetClaw, skipping retrospective:', contractId, rawTarget);
              continue;
            }
            targetClaw = rawTarget;
            mode = typeof r.mode === 'string' ? r.mode : undefined;
            miningTaskId = typeof r.miningTaskId === 'string' ? r.miningTaskId : undefined;
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
              console.warn('[daemon] Failed to read by-contract index, skipping retrospective:', contractId, e instanceof Error ? e.message : String(e));
            }
            continue;
          }

          // 加载契约 YAML 原始字符串
          if (!targetClaw) continue;  // 防御性检查，前面已验证
          const clawsBaseDir = path.resolve(dir, '..', 'claws');
          const clawDir = path.join(clawsBaseDir, targetClaw);
          const clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
          const contractManager = new ContractManager(clawDir, targetClaw, clawFs);

          let contractYaml: string;
          try {
            contractYaml = await contractManager.readContractYamlRaw(contractId);
          } catch (e) {
            console.warn('[daemon] Failed to load contract YAML for retrospective:', contractId, e instanceof Error ? e.message : String(e));
            continue;
          }

          // 加载当前 dispatch-skills 列表（best-effort）
          let skillsSummary = '';
          try {
            const motionFs = new NodeFileSystem({ baseDir: dir, enforcePermissions: false });
            const reg = new SkillRegistry(motionFs, 'clawspace/dispatch-skills');
            await reg.loadAll();
            const formatted = reg.formatForContext();
            if (!formatted.includes('No skills loaded')) {
              skillsSummary = formatted;
            }
          } catch (e) {
            console.warn('[daemon] Failed to load dispatch-skills for retro prompt:', e instanceof Error ? e.message : String(e));
          }

          // 构建复盘 prompt
          const retroPrompt = buildRetroPrompt(targetClaw, contractId, contractYaml, skillsSummary);

          // 构建复盘对话上下文（mining 模式继承挖掘对话，describing 模式用空上下文）
          let baseMessages: Message[] = [];
          if (mode === 'mining' && miningTaskId) {
            try {
              const messagesPath = path.join(dir, 'tasks', 'results', miningTaskId, 'messages.json');
              const raw = await fsAsync.readFile(messagesPath, 'utf-8');
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                baseMessages = parsed;
              }
            } catch (e) {
              const code = (e as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') {
                // mining 模式下 messages.json 应由 miner 写入，ENOENT 说明 miner 未正常完成持久化
                console.warn('[daemon] Mining task messages not found, retro will run without mining context:', miningTaskId);
              } else {
                console.warn('[daemon] Failed to load mining task messages:', e instanceof Error ? e.message : String(e));
              }
              // best-effort：加载失败退化为空上下文，retro 照常运行
            }
          }
          const retroMessages: Message[] = [...baseMessages, { role: 'user', content: retroPrompt }];

          // 调度复盘子代理
          const taskSystem = runtime.getTaskSystem();
          try {
            await scheduleSubAgentWithTracking(
              taskSystem,
              streamWriter,
              {
                prompt: '',
                messages: retroMessages,
                tools: ['read', 'write', 'skill', 'exec'],
                timeout: 600,
                maxSteps: DEFAULT_MAX_STEPS,
                parentClawId: 'motion',
                originClawId: 'motion',
                silent: true,
              }
            );
          } catch (e) {
            console.warn('[daemon] retrospective schedule failed, keeping pending files for retry:', e);
            continue;  // 不删文件，留待下次 daemon 重启时重试
          }

          // 调度成功后才清理 by-contract 索引（best-effort）
          await fsAsync.unlink(byContractPath).catch(e =>
            console.warn('[daemon] Failed to clean by-contract file:', e instanceof Error ? e.message : String(e))
          );
        }
      }
    : undefined;

  // 注册 uncaughtException / unhandledRejection 处理程序
  const writeCrash = (reason: unknown): void => {
    const msg = reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ''}`
      : String(reason);
    auditWriter.write('daemon_crash', `err=${msg}`);
  };

  process.on('uncaughtException', (err) => {
    writeCrash(err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    writeCrash(reason);
    process.exit(1);
  });

  const { promise, stop } = startDaemonLoop({
    runtime,
    agentDir: dir,
    clawId: name,
    inboxPendingDir,
    label: isMotion ? '[motion daemon]' : '[daemon]',
    streamWriter,
    isMotion,
    heartbeat: heartbeat ?? undefined,  // 传入心跳实例
    notifyMotionDir: isMotion ? undefined : getMotionDir(),
    onInboxMessages,   // 新增
  });

  // shutdown
  const shutdown = async (signal: string) => {
    stop();
    cronRunner?.stop();   // 停止 cron 调度器
    try {
      await runtime.stop();
    } catch (e) {
      console.error('[daemon] runtime.stop() failed:', e instanceof Error ? e.message : String(e));
    }
    streamWriter.close();
    auditWriter.write('daemon_stop', `reason=${signal.toLowerCase()}`);
    // 清理 PID 文件和 lockfile（只有文件仍属于本进程才删除，防止误删新 daemon 的文件）
    try {
      const storedPid = fsNative.readFileSync(pidFile, 'utf-8').trim();
      if (storedPid === String(process.pid)) fsNative.unlinkSync(pidFile);
    } catch (e: any) {
      console.warn(`[daemon] Failed to clean up pid file: ${e?.message}`);
    }
    try {
      const storedLockPid = fsNative.readFileSync(lockFile, 'utf-8').trim();
      if (storedLockPid === String(process.pid)) fsNative.unlinkSync(lockFile);
    } catch (e: any) {
      console.warn(`[daemon] Failed to clean up lock file: ${e?.message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const label = isMotion ? '[motion daemon]' : '[daemon]';
  console.log(`${label} Started`);
  await promise;
}
