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
 * 三态 audit：detected（检测到停滞）→ self_healed（自愈后观察到活动、计数归零）
 *           → escalated（连续 N 次自愈仍无活动、留痕待 P2a 判失败兜底，本 phase 不接判失败）。
 */

import * as path from 'path';
import { isFileNotFound, type FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { hasActiveContract } from '../core/contract/index.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import {
  WAITING_STALL_TIMEOUT_MS,
  WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS,
  WAITING_STALL_CHECK_INTERVAL_MS,
} from './constants.js';

/** 打断 waitForInbox 以立即重入轮的最小句柄（EventLoop.abort）。 */
export interface WaitingStallLoopHandle {
  abort(): void;
}

export interface WaitingStallOptions {
  fsFactory: (baseDir: string) => FileSystem;
  /** agent root（contract/ 与 inbox/ 的父目录）。 */
  agentDir: string;
  audit: AuditLog;
  eventLoop: WaitingStallLoopHandle;
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
      // 连续 N 次自愈无效：本 phase 不接判失败（归 P2a），仅留痕。
      // 重置计数避免每个节拍重复 escalated，下一次真活动仍可 self_healed（计数从 0 计）。
      selfHealAttempts = 0;
      lastActivityMs = now();
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
