/**
 * @module L6.Daemon.WaitingStall
 * @layer L6 进程边界（Daemon 事件循环）
 * @depends L1.FileSystem, L2.AuditLog, L2.Messaging, L4.ContractSystem
 * @consumers L6.DaemonLoop
 *
 * phase 1383 (P2b U3): daemon in-process 自活监测。
 *
 * 职责：claw 持有 active 契约但事件循环长时间停在等待态（无 turn 在飞、无活动）时，
 * daemon 自己检测并自愈（强制重入轮 / 重扫 inbox）。这是进程内自知识判定——
 * daemon 知道自己的契约状态、知道自己最后一次活动时间——无需 watchdog 跨进程观察。
 *
 * 两层边界（与 Step D 心跳文件配合）：
 *   - 事件循环活着时（本模块有效）：in-process 定时器触发 → 自愈
 *   - 事件循环全阻塞时（sync 卡死、定时器也不触发）：本模块无效，由 Step D 心跳文件兜底重启
 *
 * 自愈动作：写一条 high-priority self-inbox 消息（与 startup_check 同机制）+
 * 调 eventLoop.abort() 打断当前 waitForInbox，下一轮 run() 立即 drainInbox 拾取。
 *
 * phase 1387 Step B 收紧：
 *   - 三路 skip（fail-open）：LLM waiting/cooldown 在途、LLM request blocked、wakeups/ 有安排——
 *     系统按既定调度推进时不判停滞。
 *   - escalated 分支改：调注入的 cancelContract(reason='agent_spontaneous_stall') 取消 active 契约
 *     判失败；cancel 失败留痕，下轮重试（幂等由 cancel 语义兜）。
 *
 * phase 1388 Step B：第四路 skip（fail-open）：AsyncTaskSystem 有 running/pending 任务——
 *   等 task_result 的 claw 是合法等待（任务停滞归 P2c AsyncTaskSystem 自检测）。
 *
 * 三态 audit：detected（检测到停滞）→ self_healed（自愈后观察到活动、计数归零）
 *           → escalated + contract_failed（连续 N 次自愈仍无活动、取消契约判失败）。
 */

import * as path from 'path';
import { isFileNotFound, type FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { notifyInbox, listWakeups } from '../foundation/messaging/index.js';
import { hasActiveContract } from '../core/contract/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import {
  WAITING_STALL_TIMEOUT_MS,
  WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS,
  WAITING_STALL_CHECK_INTERVAL_MS,
  WAITING_STALL_CONTRACT_FAIL_REASON,
} from './constants.js';

/** 打断 waitForInbox 以立即重入轮的最小句柄（EventLoop.abort）。 */
export interface WaitingStallLoopHandle {
  abort(): void;
  /**
   * phase 1387 Step B: 只读在途状态查询。
   * true = LLM retry/cooldown waiting 或 LLM request blocked 任一在途，系统正在按既定调度推进，
   * waiting-stall 应 skip（fail-open：查询抛错也按在途处理）。
   */
  isBusy?(): boolean;
}

/**
 * phase 1387 Step B: escalated 后取消当前 active 契约的最小 callback。
 * 由 daemon-loop 装配时 bind 到 ContractSystem（内部解析 active id + 调 cancel）。
 * 无 active 契约（状态漂移）应静默 no-op（audit 由 caller 兜底）；cancel 失败 throw 由 caller 留痕重试。
 */
export type WaitingStallCancelContract = (reason: string) => Promise<void>;

export interface WaitingStallOptions {
  fsFactory: (baseDir: string) => FileSystem;
  /** agent root（contract/ 与 inbox/ 的父目录）。 */
  agentDir: string;
  audit: AuditLog;
  eventLoop: WaitingStallLoopHandle;
  /**
   * phase 1387 Step B: escalated 后取消 active 契约的 callback。
   * 未注入（如旧测试 / motion daemon）时退化为仅留痕、保留旧行为。
   */
  cancelContract?: WaitingStallCancelContract;
  /**
   * phase 1388 Step B: 异步任务在途查询。
   * AsyncTaskSystem 有 running/pending 任务时 claw 在合法等待 task_result，不应判停滞。
   * 查询失败 fail-open（当作在途、不判死），与既有三路 skip 同向。
   */
  asyncTasksQuery?: { hasInFlight(): Promise<boolean> };
  /** 自检节拍 ms（测试可注入短节拍）。默认 WAITING_STALL_CHECK_INTERVAL_MS。 */
  checkIntervalMs?: number;
  /** 等待态停滞阈值 ms（测试可注入）。默认 WAITING_STALL_TIMEOUT_MS。 */
  stallTimeoutMs?: number;
  /** 注入的 setInterval（测试用 fake timer）。 */
  setIntervalFn?: typeof setInterval;
  /** 注入的 clearInterval。 */
  clearIntervalFn?: typeof clearInterval;
  /** 注入的 Date.now（测试用）。 */
  now?: () => number;
}

export interface WaitingStallMonitor {
  /** 记录一次活动（turn 完成 / 进入处理 / 收到 inbox 事件）——重置等待计时。 */
  noteActivity(): void;
  /** 停止监测并清理定时器。 */
  stop(): void;
}

const INBOX_PENDING_DIR = 'inbox/pending';

/**
 * 创建并启动 waiting-stall 自活监测器。
 * 返回 noteActivity（活动打点）+ stop（关停）。
 */
export function startWaitingStallMonitor(options: WaitingStallOptions): WaitingStallMonitor {
  const {
    fsFactory,
    agentDir,
    audit,
    eventLoop,
    cancelContract,
    asyncTasksQuery,
    checkIntervalMs = WAITING_STALL_CHECK_INTERVAL_MS,
    stallTimeoutMs = WAITING_STALL_TIMEOUT_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now,
  } = options;

  const agentFs = fsFactory(agentDir);
  let lastActivityMs = now();
  let selfHealAttempts = 0;
  let stopped = false;

  const noteActivity = (): void => {
    const wasStalled = selfHealAttempts > 0;
    lastActivityMs = now();
    if (wasStalled) {
      audit.write(
        DAEMON_AUDIT_EVENTS.WAITING_STALL_SELF_HEALED,
        `prior_attempts=${selfHealAttempts}`,
      );
      selfHealAttempts = 0;
    }
  };

  const check = (): void => {
    if (stopped) return;
    const idleMs = now() - lastActivityMs;
    if (idleMs < stallTimeoutMs) return;

    void (async () => {
      if (stopped) return;

      // phase 1387 Step B: 三路 skip（系统在途、不打扰原则）。
      // 查询失败 fail-open（当作在途、不判死）。skip 期间不重置 lastActivityMs，
      // 保证系统状态退出在途后、idle 仍从最后活动起算（连续判定、不吞在途时间）。

      // (1) EventLoop 在途：LLM retry/cooldown waiting 或 LLM request blocked。
      if (eventLoop.isBusy) {
        let busy: boolean;
        try {
          busy = eventLoop.isBusy();
        } catch (err) {
          audit.write(
            DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED,
            `ctx=is_busy_query_failed`,
            `idle_ms=${idleMs}`,
            `error=${formatErr(err)}`,
          );
          busy = true;
        }
        if (busy) return;
      }

      // (2) wakeups/ 有安排（1386 定时消息原语）。读失败 fail-open。
      try {
        if (listWakeups(agentFs, '.').length > 0) return;
      } catch (err) {
        audit.write(
          DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED,
          `ctx=wakeups_list_failed`,
          `idle_ms=${idleMs}`,
          `error=${formatErr(err)}`,
        );
        return;
      }

      // (3) phase 1388 Step B: AsyncTaskSystem 在途（running/pending）——等 task_result 是合法等待。
      //     只判「有没有在途」、不判任务健康（停滞归 P2c AsyncTaskSystem 自检测）。
      //     查询失败 fail-open（与既有三路同向）。
      if (asyncTasksQuery) {
        try {
          if (await asyncTasksQuery.hasInFlight()) return;
        } catch (err) {
          audit.write(
            DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED,
            `ctx=async_tasks_query_failed`,
            `idle_ms=${idleMs}`,
            `error=${formatErr(err)}`,
          );
          return;
        }
      }

      // 判定只用 daemon 自知识：自己的 active 契约状态（进程内目录读、非跨模块）。
      // 读失败 = fail-open（假定有 active、避免漏检真停滞）。
      let active: boolean;
      try {
        active = hasActiveContract(agentFs, '.');
      } catch (err) {
        if (!isFileNotFound(err)) {
          audit.write(
            DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED,
            `ctx=active_contract_read_failed`,
            `idle_ms=${idleMs}`,
            `error=${(err as Error).message}`,
          );
        }
        active = true;
      }
      // 无契约等待 = 正常 idle，不触发。
      if (!active) {
        lastActivityMs = now();
        return;
      }

      selfHealAttempts++;
      const stalled = selfHealAttempts >= WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS;

      audit.write(
        stalled
          ? DAEMON_AUDIT_EVENTS.WAITING_STALL_ESCALATED
          : DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED,
        `idle_ms=${idleMs}`,
        `attempt=${selfHealAttempts}`,
        `max=${WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS}`,
      );

      if (stalled) {
        // phase 1387 Step B: 连续 N 次自愈无效 → 判失败，取消 active 契约。
        // cancel 成功 → 契约离开 active → waiting-stall 不再触发（幂等由 cancel 语义兜）。
        // cancel 失败 / 无注入 callback → 留痕，下轮重试（计数已重置、lastActivity 前推避免每个节拍重复）。
        selfHealAttempts = 0;
        lastActivityMs = now();
        if (!cancelContract) return;
        try {
          await cancelContract(WAITING_STALL_CONTRACT_FAIL_REASON);
          audit.write(
            DAEMON_AUDIT_EVENTS.WAITING_STALL_CONTRACT_FAILED,
            `reason=${WAITING_STALL_CONTRACT_FAIL_REASON}`,
          );
        } catch (err) {
          audit.write(
            DAEMON_AUDIT_EVENTS.WAITING_STALL_CONTRACT_FAIL_FAILED,
            `reason=${WAITING_STALL_CONTRACT_FAIL_REASON}`,
            `error=${formatErr(err)}`,
          );
        }
        return;
      }

      // 自愈：写 high-priority self-inbox + 打断等待态强制重入轮。
      // inboxFs = agentDir 的父目录（notifyInbox 以 parent root + inboxDir 绝对路径构造，同 startup-check）。
      notifyInbox(
        fsFactory(path.join(agentDir, '..')),
        {
          inboxDir: path.join(agentDir, INBOX_PENDING_DIR),
          type: 'waiting_stall_self_heal',
          source: 'daemon',
          priority: 'high',
          body: 'Daemon detected execution stalled while a contract is active. Rescanning inbox and resuming execution.',
        },
        audit,
      );
      eventLoop.abort();
    })();
  };

  const timer = setIntervalFn(check, checkIntervalMs);
  // 不阻塞进程退出（与 livenessTimer 同策略）。
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    noteActivity,
    stop: () => {
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}
