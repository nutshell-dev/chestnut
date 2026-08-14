/**
 * @module L4.AsyncTaskSystem.StallDetector
 *
 * phase 1391 Step B: SubAgentTask 任务级停滞检测。
 *
 * 三条件判据（AND）：
 *   1. running 状态（task 在 TASKS_QUEUES_RUNNING_DIR）
 *   2. task stream 无活动超过 STALL_THRESHOLD_MS
 *   3. 无 turn 在飞（stream 最后事件不是未配对的 turn_start）
 *
 * 阶梯：
 *   - 首次判停滞 → 投递 task_stage_update 阶段消息到父 claw inbox（type=task_stage_update）
 *   - 推送后仍停滞超过 FAIL_AFTER_MS → moveTaskToFailed + 既有的 is_error task_result
 *     链（sendFallbackError 先于 moveTaskToFailed，由 caller 提供）
 *
 * fail-open：
 *   - stream 缺失/读失败/解析失败 → 当作有活动（不判停滞），与 waiting-stall 同向
 *   - ToolTask 不适用，跳过
 *   - turn 在飞（stream 末尾未配对 turn_start）→ 由 timeout-controller 管，跳过
 *
 * 内存阶梯 Map 随 detector 生命周期；重启重置（检测器随父 daemon 生命周期，可接受）。
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { InboxMessage } from '../../foundation/messaging/index.js';
import { INBOX_PENDING_DIR } from '../../foundation/messaging/index.js';
import { newUuid } from '../../foundation/node-utils/index.js';

import { STREAM_FILE } from '../../foundation/stream/index.js';
import { STREAM_AGENT_EVENTS } from '../agent-executor/index.js';
import { TASKS_QUEUES_RESULTS_DIR } from './dirs.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import type { SubAgentTask, FullTaskId, TaskId } from './types.js';
import { formatErr } from './_helpers.js';

export type { SubAgentTask } from './types.js';

/**
 * 从 running 目录扫描出的一个 SubAgentTask（已解析、kind 已过滤）。
 * detector 不自己读文件系统；由 caller 注入 scan/lookup/action 回调，保持纯逻辑、可测。
 */
export interface RunningSubAgentTask {
  task: SubAgentTask;
  /** running file 的绝对/相对路径（caller 语义）。 */
  runningPath: string;
}

export interface StallDetectorDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  /**
   * 扫描 running 目录、返回所有 kind==='subagent' 任务。
   * ToolTask / 损坏文件 / parse 失败由 caller 过滤/留痕；detector 不重复处理。
   */
  listRunningSubagentTasks(): Promise<RunningSubAgentTask[]>;
  /**
   * 投递 is_error task_result（fallback 链），detector 不直接 import result-delivery，
   * 保持模块可独立单测、与 system.ts 的 sendFallbackError 注入同源。
   */
  sendFallbackError(task: SubAgentTask, errorMsg: string): Promise<void>;
  /** 移动 running → failed（system.ts 私有方法，由 caller 注入）。 */
  moveTaskToFailed(taskId: TaskId): Promise<void>;
  /**
   * 写 inbox 消息（task_stage_update 投递通道）。
   * 默认走 foundation/messaging writeInboxAsync；测试可注入 mock。
   */
  writeInboxAsync(
    fs: FileSystem,
    inboxDir: string,
    message: InboxMessage,
    audit: AuditLog,
  ): Promise<void>;
  /** 自检节拍 ms。测试可注入短节拍。 */
  checkIntervalMs?: number;
  /** 停滞阈值 ms。测试可注入。 */
  stallThresholdMs?: number;
  /** 推送后判失败窗口 ms。测试可注入。 */
  failAfterMs?: number;
  /** 注入的 setInterval（测试用 fake timer）。 */
  setIntervalFn?: typeof setInterval;
  /** 注入的 clearInterval。 */
  clearIntervalFn?: typeof clearInterval;
  /** 注入的 Date.now（测试用）。 */
  now?: () => number;
}

export interface StallDetectorHandle {
  /** 停止扫描并清理定时器。 */
  stop(): void;
  /**
   * 触发一次扫描（测试可直接驱动、不依赖 timer）。
   * 生产路径不调它；保持 export 以便单测断言。
   */
  checkOnce(): Promise<void>;
}

interface StallState {
  /** 首次推送阶段消息的时间戳（ms）。 */
  pushedAt: number;
}

/**
 * 创建并启动 stall 检测器。返回 stop 句柄。
 * 定时器 unref（不阻塞进程退出，同 waiting-stall 策略）。
 */
export function startStallDetector(deps: StallDetectorDeps): StallDetectorHandle {
  const {
    fs,
    auditWriter,
    listRunningSubagentTasks,
    sendFallbackError,
    moveTaskToFailed,
    writeInboxAsync,
    checkIntervalMs,
    stallThresholdMs,
    failAfterMs,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now,
  } = deps;

  const effectiveCheckInterval =
    checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const effectiveStallThreshold =
    stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const effectiveFailAfter = failAfterMs ?? DEFAULT_FAIL_AFTER_MS;

  const stalledTasks = new Map<string, StallState>();
  let stopped = false;

  async function checkOnce(): Promise<void> {
    if (stopped) return;
    let tasks: RunningSubAgentTask[];
    try {
      tasks = await listRunningSubagentTasks();
    } catch (err) {
      auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_STALL_SCAN_FAILED,
        `context=list_running`,
        `error=${formatErr(err)}`,
      );
      return;
    }

    const stillStalledIds = new Set<string>();

    for (const { task } of tasks) {
      const taskId = task.id;
      const streamPath = `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${STREAM_FILE}`;

      const observation = readStreamObservation(fs, streamPath);
      // fail-open: stream 缺失/读失败/解析失败 → 当作有活动，不判停滞。
      if (observation.kind !== 'ok') continue;

      const idleMs = now() - observation.lastEventTs;
      if (idleMs < effectiveStallThreshold) continue;

      // turn 在飞（turn_start 无配对 turn_end/interrupted/error）→ timeout-controller 管。
      if (observation.turnInFlight) continue;

      stillStalledIds.add(taskId);

      const existing = stalledTasks.get(taskId);
      if (!existing) {
        // 1) 首次停滞：推送阶段消息
        const pushedAt = now();
        const ok = await pushStageUpdate({
          fs,
          auditWriter,
          writeInboxAsync,
          task,
          idleMs,
          now: pushedAt,
        });
        if (ok) {
          stalledTasks.set(taskId, { pushedAt });
          auditWriter.write(
            TASK_AUDIT_EVENTS.TASK_STALL_STAGE_PUSHED,
            `fullTaskId=${taskId}`,
            `shortTaskId=${task.shortId}`,
            `idle_ms=${idleMs}`,
          );
        }
        continue;
      }

      // 2) 已推送过：检查是否超 fail-after 窗口
      if (now() - existing.pushedAt < effectiveFailAfter) continue;

      const failReason = `SubAgentTask stalled: no stream activity for ${idleMs}ms after stage update`;
      try {
        await sendFallbackError(task, failReason);
      } catch (err) {
        auditWriter.write(
          TASK_AUDIT_EVENTS.TASK_STALL_SCAN_FAILED,
          `context=send_fallback_error`,
          `fullTaskId=${taskId}`,
          `shortTaskId=${task.shortId}`,
          `error=${formatErr(err)}`,
        );
        // 投递失败不继续 moveToFailed（避免父 claw 永不收 task_result）；下轮重试。
        continue;
      }
      try {
        await moveTaskToFailed(taskId as TaskId);
      } catch (err) {
        auditWriter.write(
          TASK_AUDIT_EVENTS.TASK_STALL_SCAN_FAILED,
          `context=move_to_failed`,
          `fullTaskId=${taskId}`,
          `shortTaskId=${task.shortId}`,
          `error=${formatErr(err)}`,
        );
        // move 失败：fallback 已投递（task_result is_error 已到父 inbox），running 文件保留由 recovery 路由。
      }
      stalledTasks.delete(taskId);
      auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_STALL_FAILED,
        `fullTaskId=${taskId}`,
        `shortTaskId=${task.shortId}`,
        `idle_ms=${idleMs}`,
        `fail_after_ms=${effectiveFailAfter}`,
      );
    }

    // 清理已不在 running 的任务阶梯状态（任务自然完成/取消）。
    for (const id of stalledTasks.keys()) {
      if (!stillStalledIds.has(id)) stalledTasks.delete(id);
    }
  }

  const timer = setIntervalFn(() => {
    void checkOnce();
  }, effectiveCheckInterval);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop: () => {
      stopped = true;
      clearIntervalFn(timer);
    },
    checkOnce,
  };
}

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_STALL_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_FAIL_AFTER_MS = 5 * 60 * 1000;

type StreamObservation =
  | {
      kind: 'ok';
      lastEventTs: number;
      turnInFlight: boolean;
    }
  | { kind: 'unavailable' };

/**
 * 读取 task stream 末尾、判定 (lastEventTs, turnInFlight)。
 *
 * fail-open：stream 缺失 / 读失败 / 无有效事件 → unavailable（caller 不判停滞）。
 * turnInFlight 判定：从末尾向前扫，turn_end/turn_interrupted/turn_error 关 turn；
 * turn_start 在关 turn 之前出现 → 在飞。
 */
function readStreamObservation(fs: FileSystem, streamPath: string): StreamObservation {
  let content: string;
  try {
    content = fs.readSync(streamPath);
  } catch (err) {
    // silent: fail-open —— stream 缺失或读失败一律当作「有活动」不判停滞，与 waiting-stall 同向
    // （宁可少判、不可误杀合法等待；isFileNotFound 与其它 IO error 同处理）。
    if (isFileNotFound(err)) return { kind: 'unavailable' };
    return { kind: 'unavailable' };
  }
  if (!content) return { kind: 'unavailable' };

  const lines = content.split('\n');
  let lastEventTs = 0;
  let turnInFlight = false;
  let foundAny = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let evt: { ts?: number; type?: string };
    try {
      evt = JSON.parse(line) as { ts?: number; type?: string };
    } catch {
      continue;
    }
    if (!foundAny) {
      if (typeof evt.ts === 'number') lastEventTs = evt.ts;
      foundAny = true;
    }
    if (evt.type === STREAM_AGENT_EVENTS.TURN_END) {
      turnInFlight = false;
      break;
    }
    if (
      evt.type === STREAM_AGENT_EVENTS.TURN_INTERRUPTED ||
      evt.type === STREAM_AGENT_EVENTS.TURN_ERROR
    ) {
      turnInFlight = false;
      break;
    }
    if (evt.type === STREAM_AGENT_EVENTS.TURN_START) {
      turnInFlight = true;
      break;
    }
  }

  if (!foundAny || lastEventTs === 0) return { kind: 'unavailable' };
  return { kind: 'ok', lastEventTs, turnInFlight };
}

interface PushStageUpdateParams {
  fs: FileSystem;
  auditWriter: AuditLog;
  writeInboxAsync: StallDetectorDeps['writeInboxAsync'];
  task: SubAgentTask;
  idleMs: number;
  now: number;
}

async function pushStageUpdate(params: PushStageUpdateParams): Promise<boolean> {
  const { fs, auditWriter, writeInboxAsync, task, idleMs, now } = params;
  const content = JSON.stringify({
    taskId: task.shortId,
    fullTaskId: task.id as FullTaskId,
    stage: 'stalled',
    idle_ms: idleMs,
    runtime_ms: now - Date.parse(task.createdAt),
  });
  const msg: InboxMessage = {
    id: newUuid(),
    type: 'task_stage_update',
    from: 'system',
    to: task.parentClawId,
    content,
    priority: 'normal',
    timestamp: new Date(now).toISOString(),
  };
  try {
    await writeInboxAsync(fs, INBOX_PENDING_DIR, msg, auditWriter);
    return true;
  } catch (err) {
    auditWriter.write(
      TASK_AUDIT_EVENTS.TASK_STALL_SCAN_FAILED,
      `context=stage_update_inbox_write`,
      `fullTaskId=${task.id}`,
      `shortTaskId=${task.shortId}`,
      `error=${formatErr(err)}`,
    );
    return false;
  }
}
