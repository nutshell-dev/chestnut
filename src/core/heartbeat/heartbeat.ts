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
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';

/**
 * Default heartbeat interval (seconds); 0 = disabled by design.
 * phase 1405: 省略 interval 等价于显式 0，Heartbeat 模块自身保证默认禁用；
 * 只有显式指定 interval > 0 才启用周期触发。
 */
const HEARTBEAT_INTERVAL_SEC_DEFAULT = 0;

/** phase 84: DI callback - caller (L6 装配期) bind chestnutRoot + targetClawId + audit */
type HeartbeatNotifyInboxFn = (message: InboxMessageOptionsBase) => void;

/**
 * Phase 1791: Heartbeat-owned 调度游标持久化契约（HEARTBEAT-SCHEDULE-CURSOR-NOT-DURABLE）。
 *
 * cursor 记录最近一次成功发送或去重跳过的时间；owner 持有单一持久化 cursor
 * 文件，路径由调用方（装配期）注入，避免跨层路径耦合。
 */
export type HeartbeatCursor = { schema_version: 1; last_run_ms: number };

/**
 * cursor 读取 typed outcome：读取失败不伪造新时间 ——
 * - `found`：schema 校验通过，恢复 due 基线；
 * - `absent`：首次启动（有审计证据），从 now 等满 interval；
 * - `malformed` / `unavailable`：显式 degraded（审计 + 保留错误），安全策略 =
 *   从 now 重建等满 interval，不把故障压成 found。
 */
export type CursorRead =
  | { kind: 'found'; value: HeartbeatCursor }
  | { kind: 'absent' }
  | { kind: 'malformed' | 'unavailable'; error: string };

export interface HeartbeatCursorStore {
  read(): Promise<CursorRead>;
  write(cursor: HeartbeatCursor): Promise<void>;
}

/**
 * Heartbeat-owned cursor 文件存取实现：原子写（writeAtomic）+ schema 校验读。
 * ENOENT → absent；其余 IO 故障 → unavailable；JSON/schema 不符 → malformed。
 */
export function createHeartbeatCursorStore(fs: FileSystem, cursorPath: string): HeartbeatCursorStore {
  return {
    async read(): Promise<CursorRead> {
      let raw: string;
      try {
        raw = await fs.read(cursorPath);
      } catch (e) {
        if (isFileNotFound(e)) return { kind: 'absent' };
        return { kind: 'unavailable', error: formatErr(e) };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { kind: 'malformed', error: formatErr(e) };
      }
      const rec = parsed as Record<string, unknown>;
      if (
        typeof rec === 'object' && rec !== null
        && rec.schema_version === 1
        && typeof rec.last_run_ms === 'number'
        && Number.isFinite(rec.last_run_ms)
      ) {
        return { kind: 'found', value: { schema_version: 1, last_run_ms: rec.last_run_ms } };
      }
      return { kind: 'malformed', error: 'cursor schema mismatch' };
    },
    async write(cursor: HeartbeatCursor): Promise<void> {
      await fs.writeAtomic(cursorPath, JSON.stringify(cursor));
    },
  };
}

interface HeartbeatOptions {
  /** 心跳间隔（秒），默认 {@link HEARTBEAT_INTERVAL_SEC_DEFAULT}（0 = 禁用）；仅显式正值启用 */
  interval?: number;
  audit: AuditLog;
  inboxReader: InboxReader;
  /** phase 84: caller-bound notify (L6 装配期 bind fs + chestnutRoot + MOTION_CLAW_ID + audit) */
  notifyInbox: HeartbeatNotifyInboxFn;
  /**
   * phase 1767: 注入时钟读取（sole purpose: test 控时钟 / wall-clock rollback 核证）。
   * 缺省 Date.now。仅 Heartbeat due 判断使用，不得扩散到无关模块。
   */
  now?: () => number;
  /**
   * phase 1791: Heartbeat-owned cursor 存取 capability（必填，装配期注入路径）。
   * 恢复经显式 `initialize()` —— 构造器保持同步，不伪造已恢复。
   */
  cursorStore: HeartbeatCursorStore;
}

/**
 * Motion 心跳触发器
 */
export class Heartbeat {
  private readonly interval: number;
  private readonly enabled: boolean;
  private lastRun: number;
  private readonly audit: AuditLog;
  private readonly inboxReader: InboxReader;
  private readonly notifyInbox: HeartbeatNotifyInboxFn;
  private readonly now: () => number;
  private readonly cursorStore: HeartbeatCursorStore;

  constructor(options: HeartbeatOptions) {
    const intervalSec = options.interval ?? HEARTBEAT_INTERVAL_SEC_DEFAULT;
    this.enabled = intervalSec > 0;
    this.interval = Math.max(0, intervalSec) * 1000;
    this.now = options.now ?? Date.now;
    this.lastRun = this.now();  // 启动后等满一个 interval 再首次触发
    this.audit = options.audit;
    this.inboxReader = options.inboxReader;
    this.notifyInbox = options.notifyInbox;
    this.cursorStore = options.cursorStore;
  }

  /**
   * phase 1791: 显式恢复点 —— 读取持久 cursor 重建 due 基线。
   *
   * - `found`：lastRun 恢复为 cursor 值（后续 rollback 检测复用 observeNow）；
   * - `absent`：首次启动，审计证据 + 保持 now 基线（等满 interval）；
   * - `malformed` / `unavailable`：degraded 审计（stage/error 保留），不伪造
   *   恢复时间，安全策略 = 从 now 重建等满 interval。
   *
   * 返回 CursorRead 迫使调用方显式处理恢复状态；重复调用幂等。
   */
  async initialize(): Promise<CursorRead> {
    const read = await this.cursorStore.read();
    switch (read.kind) {
      case 'found':
        this.lastRun = read.value.last_run_ms;
        break;
      case 'absent':
        this.audit.write(HEARTBEAT_AUDIT_EVENTS.CURSOR_ABSENT, 'state=first_boot');
        break;
      case 'malformed':
      case 'unavailable':
        this.audit.write(
          HEARTBEAT_AUDIT_EVENTS.CURSOR_DEGRADED,
          `stage=${read.kind}`,
          `error=${read.error}`,
        );
        break;
    }
    return read;
  }

  /**
   * phase 1791: 原子持久化 cursor；只有 persist 成功才前移内存游标 ——
   * persist 失败保留旧 lastRun（下 tick 立即重试；dedup 分支防重复 notify），
   * 不把未持久化事实标成 durable。
   */
  private async persist(now: number): Promise<void> {
    try {
      await this.cursorStore.write({ schema_version: 1, last_run_ms: now });
      this.lastRun = now;
    } catch (error) {
      this.audit.write(
        HEARTBEAT_AUDIT_EVENTS.CURSOR_PERSIST_FAILED,
        `last_run_ms=${now}`,
        `error=${formatErr(error)}`,
      );
    }
  }

  /**
   * phase 1767 (Phase 1766 冻结设计): 观测当前时钟；检测 wall-clock 回拨
   * （now < lastRun）时显式重锚定 due 基线为当前 now 并写可观察 rollback
   * 事实。重锚定后须等满一个 interval 才 due —— 回拨不得触发重复 heartbeat。
   * phase 1791: lastRun 持久化由 cursorStore 承担（fire 成功/persist 后前移）；
   * 本函数仅观测与重锚定内存基线。
   */
  private observeNow(): number {
    const now = this.now();
    if (now < this.lastRun) {
      this.audit.write(
        HEARTBEAT_AUDIT_EVENTS.CLOCK_ROLLBACK,
        `last_run=${this.lastRun}`,
        `now=${now}`,
        `delta_ms=${now - this.lastRun}`,
      );
      this.lastRun = now;  // 重锚定 due 基线
    }
    return now;
  }

  /**
   * 检查是否应该执行心跳
   */
  isDue(): boolean {
    if (!this.enabled) return false;
    const now = this.observeNow();
    return now - this.lastRun >= this.interval;
  }

  /**
   * 触发心跳：向 motion inbox 写入 heartbeat 消息
   */
  async fire(): Promise<void> {
    if (!this.enabled) return;
    try {
      // 走 InboxReader 受信路径（phase1059）：peek 不消费，带 dedup + race 处理
      const metas = await this.inboxReader.peekMetas();
      const hasPendingHeartbeat = metas.some((m) => m.type === 'heartbeat');
      if (hasPendingHeartbeat) {
        // phase 1791: 去重跳过也记录 cursor（最近一次成功发送或去重跳过的时间）
        await this.persist(this.observeNow());
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
      // phase 1791: notify 成功后原子持久化；persist 成功才前移 lastRun
      await this.persist(this.observeNow());
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
