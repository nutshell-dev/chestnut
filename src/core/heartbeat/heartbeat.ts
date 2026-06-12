/**
 * Heartbeat - Motion 心跳触发器
 *
 * 间隔可配置（heartbeat_interval_ms），默认禁用（0）。开启后向 motion inbox 写入 heartbeat 消息。
 *
 * phase 84 (在 phase84 worktree): L4 surface 去 chestnutRoot - DI callback pattern
 * (heartbeat 不知 chestnut 拓扑、不持 ChestnutRoot brand、纯接 notify callback、
 * caller 装配期 bind chestnutRoot + MOTION_CLAW_ID + notifyClaw)。
 * per M#5 严守 (L4 不预设上层装配根概念) + M#1 SRP (heartbeat 0 知 messaging 路径业务)。
 */

import type { InboxReader, InboxMessageOptionsBase } from '../../foundation/messaging/index.js';
import { HEARTBEAT_AUDIT_EVENTS } from './audit-events.js';
import type { AuditLog } from '../../foundation/audit/index.js';

/** Default heartbeat interval (seconds); 5 min by design */
const HEARTBEAT_INTERVAL_SEC_DEFAULT = 300;

/** phase 84: DI callback - caller (L6 装配期) bind chestnutRoot + targetClawId + audit */
export type HeartbeatNotifyInboxFn = (message: InboxMessageOptionsBase) => void;

export interface HeartbeatOptions {
  /** 心跳间隔（秒），默认 {@link HEARTBEAT_INTERVAL_SEC_DEFAULT}（5分钟） */
  interval?: number;
  audit: AuditLog;
  inboxReader: InboxReader;
  /** phase 84: caller-bound notify (L6 装配期 bind fs + chestnutRoot + MOTION_CLAW_ID + audit) */
  notifyInbox: HeartbeatNotifyInboxFn;
}

/**
 * Motion 心跳触发器
 */
export class Heartbeat {
  private readonly interval: number;
  private lastRun: number;
  private readonly audit: AuditLog;
  private readonly inboxReader: InboxReader;
  private readonly notifyInbox: HeartbeatNotifyInboxFn;

  constructor(options: HeartbeatOptions) {
    this.interval = (options.interval ?? HEARTBEAT_INTERVAL_SEC_DEFAULT) * 1000;
    this.lastRun = Date.now();  // 启动后等满一个 interval 再首次触发
    this.audit = options.audit;
    this.inboxReader = options.inboxReader;
    this.notifyInbox = options.notifyInbox;
  }

  /**
   * 检查是否应该执行心跳
   */
  isDue(): boolean {
    const now = Date.now();
    return now - this.lastRun >= this.interval;
  }

  /**
   * 触发心跳：向 motion inbox 写入 heartbeat 消息
   */
  async fire(): Promise<void> {
    try {
      // 走 InboxReader 受信路径（phase1059）：peek 不消费，带 dedup + race 处理
      const metas = await this.inboxReader.peekMetas();
      const hasPendingHeartbeat = metas.some((m) => m.type === 'heartbeat');
      if (hasPendingHeartbeat) {
        this.lastRun = Date.now();
        return;
      }

      this.notifyInbox({
        type: 'heartbeat',
        source: 'system',
        priority: 'low',
        // phase 1419: heartbeat formatter 0 读 ctx.body（措辞由 formatter 拼 base + HEARTBEAT.md）→ sender 不传 dead payload
        body: '',
        idPrefix: 'hb',
      });
      this.lastRun = Date.now();  // 只在成功写入后更新
    } catch (error) {
      this.audit.write(
        HEARTBEAT_AUDIT_EVENTS.FIRE_FAILED,
        'context=Heartbeat.fire',
        `error=${String(error)}`,
      );
      // fire() 是定时器回调，不 rethrow（无上层 handler）
      // lastRun 未更新 → 下次 isDue() 立即可重试
    }
  }
}

/**
 * Factory: createHeartbeat
 * 装配期构造 Heartbeat / 承 phase212 D.1 工厂模板.
 *
 * phase 84: 删 baseDir param、caller 在 opts.notify 内 bind chestnutRoot
 */
export function createHeartbeat(opts: HeartbeatOptions): Heartbeat {
  return new Heartbeat(opts);
}
