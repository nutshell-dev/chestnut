/**
 * @module L2c.Messaging.ClawNotify
 *
 * cross-target claw 投递 adapter — Messaging own「发送」：
 * 目标位置由拓扑 owner 经注入 resolver 提供（Messaging 不持 claw 布局知识），
 * envelope 语义（type 默认 + interrupt → priority 派生）与落盘/DLQ/containment
 * 检查留 Messaging。
 *
 * phase 1864 Step C（CT-D2）：自 core/claw-topology/claw-instance-paths.ts 的
 * routeNotifyClaw / routeNotifyClawAsync 迁入；行为 1:1（含 phase 936/937 containment、
 * phase 942 throwing 语义、phase 943 TOCTOU guard、phase 944 id 前置校验）。
 */

import type { FileSystem } from '../fs/index.js';
import type { MessagingAuditSink } from './audit-sink.js';
import type { InboxMessageOptionsBase } from './inbox-writer.js';
import { InboxWriter, makeInboxPath } from './inbox-writer.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from './config-schema.js';
import { assertInboxTarget, notifyClaw } from './notify.js';
import type { Priority } from './types.js';

/**
 * 目标 claw 的物理位置事实（拓扑 owner 解析；Messaging 只消费）。
 *
 * - clawRoot：目标 claw 根（`<chestnut-root>/motion` 或 `<chestnut-root>/claws/<id>`）
 * - inboxDir：`<clawRoot>/inbox/pending`
 * - dlqDir：目标缺失时的 dead-letter 落点；motion 目标无 DLQ（undefined）
 */
export interface ClawNotifyTarget {
  readonly clawRoot: string;
  readonly inboxDir: string;
  readonly dlqDir?: string;
}

/** 目标位置解析 capability（拓扑 owner 注入；非法 id 由 resolver 侧抛错）。 */
export type ClawNotifyTargetResolver = (targetClawId: string) => ClawNotifyTarget;

/**
 * notify 工具意图（无 envelope 形态）：type 默认与 interrupt → priority 派生
 * 归 Messaging，caller 只表达业务意图。
 */
export interface ClawNotifyIntent {
  /** envelope source（装配期注入的源身份，如 motion capability）。 */
  readonly source: string;
  readonly body: string;
  /** envelope type；缺省 'message'（wire 默认）。 */
  readonly type?: string;
  /** true（默认）= step boundary 中断、high priority；false = normal priority。 */
  readonly interrupt?: boolean;
}

export interface ClawNotifier {
  /** envelope 显式投递：best-effort（含 DLQ 路由；同 phase 705 notifyClaw 语义、不 throw）。 */
  notify(targetClawId: string, message: InboxMessageOptionsBase): void;
  /** envelope 显式投递：throwing（phase 942；无 DLQ 路由）。 */
  notifyAsync(targetClawId: string, message: InboxMessageOptionsBase): Promise<void>;
  /** 工具意图投递：throwing；envelope 由 Messaging 构造。 */
  notifyIntentAsync(targetClawId: string, intent: ClawNotifyIntent): Promise<void>;
}

export interface ClawNotifierDeps {
  fs: FileSystem;
  audit: MessagingAuditSink;
  /** 位置解析 capability（拓扑 owner 提供）。 */
  resolveTarget: ClawNotifyTargetResolver;
}

/** notify 工具 interrupt 语义 → envelope priority（Messaging own envelope 语义）。 */
export function clawNotifyPriority(interrupt: boolean): Priority {
  return interrupt ? 'high' : 'normal';
}

export function createClawNotifier(deps: ClawNotifierDeps): ClawNotifier {
  const { fs, audit, resolveTarget } = deps;

  const notify = (targetClawId: string, message: InboxMessageOptionsBase): void => {
    const target = resolveTarget(targetClawId);
    notifyClaw(fs, target.clawRoot, target.inboxDir, target.dlqDir, message, audit);
  };

  const notifyAsync = async (targetClawId: string, message: InboxMessageOptionsBase): Promise<void> => {
    const target = resolveTarget(targetClawId);

    // phase 943: TOCTOU guard — caller 的 exist-check 可能与删除/重建竞态。
    // 写入前复核 target root 真实存在，避免复活孤儿 claw 目录。
    if (!fs.existsSync(target.clawRoot)) {
      throw new Error(`Target claw root does not exist: ${target.clawRoot}`);
    }
    assertInboxTarget(fs, target.clawRoot, target.inboxDir);

    // phase 942/943: writeSync 的落盘失败必须上抛（工具侧统一边界转 ToolResult）；
    // 保持同步写语义（原 routeNotifyClawAsync 同形）。
    InboxWriter.__internal_create(
      fs,
      makeInboxPath(target.inboxDir),
      audit,
      MESSAGING_WRITER_LIMITS_DEFAULT,
    ).writeSync(message);
  };

  const notifyIntentAsync = async (targetClawId: string, intent: ClawNotifyIntent): Promise<void> => {
    await notifyAsync(targetClawId, {
      type: intent.type ?? 'message',
      source: intent.source,
      priority: clawNotifyPriority(intent.interrupt ?? true),
      body: intent.body,
    });
  };

  return { notify, notifyAsync, notifyIntentAsync };
}
