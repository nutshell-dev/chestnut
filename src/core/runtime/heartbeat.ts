/**
 * Heartbeat - Motion 心跳触发器
 *
 * 间隔可配置（heartbeat_interval_ms），默认禁用（0）。开启后向 motion inbox 写入 heartbeat 消息
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { InboxWriter } from '../../foundation/messaging/index.js';
import { HEARTBEAT_AUDIT_EVENTS } from './heartbeat-audit-events.js';
import { AuditWriter } from '../../foundation/audit/writer.js';
import type { Audit } from '../../foundation/audit/index.js';

export interface HeartbeatOptions {
  /** 心跳间隔（秒），默认 300（5分钟） */
  interval?: number;
  fs?: FileSystem;
  audit?: Audit;
}

/**
 * Motion 心跳触发器
 */
export class Heartbeat {
  private baseDir: string;
  private interval: number;
  private lastRun: number;
  private fs?: FileSystem;
  private audit?: Audit;

  constructor(baseDir: string, options: HeartbeatOptions = {}) {
    this.baseDir = baseDir;
    this.interval = (options.interval ?? 300) * 1000;
    this.lastRun = Date.now();  // 启动后等满一个 interval 再首次触发
    this.fs = options.fs;
    this.audit = options.audit;
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
  fire(): void {
    try {
      const fs = this.fs ?? new NodeFileSystem({ baseDir: this.baseDir, enforcePermissions: false });
      const inboxDir = path.join(this.baseDir, 'motion', 'inbox', 'pending');
      fs.ensureDirSync(inboxDir);

      // 去重：已有未处理心跳则跳过
      const existing = fs.listSync(inboxDir);
      if (existing.some(f => f.name.includes('_heartbeat_'))) {
        this.lastRun = Date.now();  // 去重也重置计时器，避免重复检查
        return;
      }

      const audit = this.audit ?? new AuditWriter(fs, path.join(this.baseDir, 'audit.tsv'));
      new InboxWriter(fs, inboxDir, audit).writeSync({
        type: 'heartbeat',
        source: 'system',
        priority: 'low',
        body: '心跳触发，请巡查。',
        idPrefix: 'hb',
      });
      this.lastRun = Date.now();  // 只在成功写入后更新
    } catch (error) {
      // lastRun 未更新 → 下次 isDue() 立即可重试
      this.audit?.write(
        HEARTBEAT_AUDIT_EVENTS.FIRE_FAILED,
        'context=Heartbeat.fire',
        `error=${String(error)}`,
      );
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
