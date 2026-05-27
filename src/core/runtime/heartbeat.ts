/**
 * Heartbeat - Motion 心跳触发器
 *
 * 间隔可配置（heartbeat_interval_ms），默认禁用（0）。开启后向 motion inbox 写入 heartbeat 消息
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import type { InboxReader } from '../../foundation/messaging/index.js';
import { HEARTBEAT_AUDIT_EVENTS } from './heartbeat-audit-events.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import type { AuditLog } from '../../foundation/audit/index.js';

export interface HeartbeatOptions {
  /** 心跳间隔（秒），默认 300（5分钟） */
  interval?: number;
  fs: FileSystem;
  audit: AuditLog;
  inboxReader: InboxReader;
}

/**
 * Motion 心跳触发器
 */
export class Heartbeat {
  private readonly baseDir: string;
  private readonly interval: number;
  private lastRun: number;
  private readonly fs: FileSystem;
  private readonly audit: AuditLog;
  private readonly inboxReader: InboxReader;

  constructor(baseDir: string, options: HeartbeatOptions) {
    this.baseDir = baseDir;
    this.interval = (options.interval ?? 300) * 1000;
    this.lastRun = Date.now();  // 启动后等满一个 interval 再首次触发
    this.fs = options.fs;
    this.audit = options.audit;
    this.inboxReader = options.inboxReader;
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

      notifyClaw(this.fs, this.baseDir, MOTION_CLAW_ID, {
        type: 'heartbeat',
        source: 'system',
        priority: 'low',
        body: '心跳触发，请巡查。',
        idPrefix: 'hb',
      }, this.audit);
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
 */
export function createHeartbeat(baseDir: string, opts: HeartbeatOptions): Heartbeat {
  return new Heartbeat(baseDir, opts);
}
