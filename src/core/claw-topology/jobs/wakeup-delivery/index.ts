/**
 * @module L4.ClawTopology.WakeupDelivery
 *
 * 业务：每 cron tick 扫所有 claws/{*}/wakeups（含 motion 自身）→ 到期项投递到该 claw
 * inbox（body = message 原文、type = `wakeup`）→ 投递成功才删安排文件；失败保留 + audit、
 * 下 tick 重试。
 *
 * 幂等（deliver-then-delete，先投后删）：
 * - 投递成功 → 删除安排文件。删除若失败，下 tick 会重复投递一次；routeNotifyClaw 文件名
 *   含独立 storage UUID（phase 1230），重复投递只产生重复 inbox 消息、不破坏状态。
 * - 投递失败 → 保留文件 + audit wakeup_deliver_failed，下 tick 重试（wakeup_deliver_retry）。
 * - 不采用「先删后投」：删除成功但投递失败会永久丢消息，与「持久化保证不丢」冲突。
 *
 * 重启恢复：安排落盘，motion 挂期间到期项保留 store、重启后补投。
 *
 * Design: design/modules/l2a_cron.md (Cron protocol) + phase 1386 plan.
 */

import type { AuditLog } from '../../../../foundation/audit/index.js';
import { formatErr } from '../../../../foundation/node-utils/index.js';
import type { FileSystem } from '../../../../foundation/fs/index.js';
import type { InboxMessageOptionsBase } from '../../../../foundation/messaging/index.js';
import {
  consumeDueWakeups,
  listWakeups,
  removeWakeup,
  MESSAGING_AUDIT_EVENTS,
} from '../../../../foundation/messaging/index.js';
import type { ClawTopology } from '../../types.js';
import type { CronJob, CronJobGlobalConfig } from '../../../../foundation/cron/index.js';
import { parseSchedule } from '../../../../foundation/cron/index.js';

/** Cron job timeout per M#2. 10s 充裕：scan = JSON parse only + inbox write. */
export const WAKEUP_DELIVERY_CRON_TIMEOUT_MS = 10_000;

export interface WakeupDeliveryJobDeps {
  /** caller (装配期) 注入的 claw topology（枚举各 claw + 解析 clawDir）。 */
  clawTopology: ClawTopology;
  fs: FileSystem;
  audit: AuditLog;
  /**
   * 投递回调：把 wakeup 消息写到目标 claw inbox。
   * 装配期 bind chestnutRoot + MOTION_CLAW_ID（motion 作为 sender）。
   * 失败应 reject/throw，保留安排待重试。
   */
  notifyClaw: (targetClawId: string, message: InboxMessageOptionsBase) => Promise<void> | void;
  /** Sender claw id（motion）。L4 不预设业务角色、由 L6 装配注入（M#5 / phase 520）。 */
  sourceClawId: string;
}

export interface WakeupDeliveryTickResult {
  delivered: number;
  failed: number;
}

/**
 * 投递一个 claw 的到期 wakeups。隔离单 claw 异常：单个 claw 失败不阻断其余 claw。
 */
async function deliverForClaw(
  deps: WakeupDeliveryJobDeps,
  clawId: string,
  clawDir: string,
  now: Date,
): Promise<{ delivered: number; failed: number }> {
  let due;
  try {
    due = consumeDueWakeups(deps.fs, clawDir, now);
  } catch (e) {
    deps.audit.write(
      MESSAGING_AUDIT_EVENTS.WAKEUP_DELIVER_FAILED,
      `clawId=${clawId}`,
      'stage=scan',
      `reason=${formatErr(e)}`,
    );
    return { delivered: 0, failed: listWakeups(deps.fs, clawDir).length };
  }

  let delivered = 0;
  let failed = 0;
  for (const record of due) {
    try {
      await deps.notifyClaw(clawId, {
        type: 'wakeup',
        source: deps.sourceClawId,
        priority: 'normal',
        body: record.message,
        metadata: { wakeup_id: record.id, scheduled_for: record.deliverAt },
      });
    } catch (e) {
      failed++;
      deps.audit.write(
        MESSAGING_AUDIT_EVENTS.WAKEUP_DELIVER_FAILED,
        `clawId=${clawId}`,
        `id=${record.id}`,
        `deliverAt=${record.deliverAt}`,
        'stage=notify',
        `reason=${formatErr(e)}`,
      );
      continue;
    }

    // 投递成功才删（先投后删）。删除失败 → audit、下 tick 会重试投递（容忍一次重复）。
    try {
      removeWakeup(deps.fs, clawDir, record.id);
    } catch (e) {
      deps.audit.write(
        MESSAGING_AUDIT_EVENTS.WAKEUP_DELIVER_RETRY,
        `clawId=${clawId}`,
        `id=${record.id}`,
        'reason=delete_after_delivery_failed',
        `detail=${formatErr(e)}`,
      );
    }

    delivered++;
    deps.audit.write(
      MESSAGING_AUDIT_EVENTS.WAKEUP_DELIVERED,
      `clawId=${clawId}`,
      `id=${record.id}`,
      `deliverAt=${record.deliverAt}`,
    );
  }
  return { delivered, failed };
}

export async function runWakeupDeliveryTick(
  deps: WakeupDeliveryJobDeps,
  now: Date = new Date(),
): Promise<WakeupDeliveryTickResult> {
  let totalDelivered = 0;
  let totalFailed = 0;
  for (const clawId of deps.clawTopology.enumerate()) {
    let location;
    try {
      location = deps.clawTopology.resolve(clawId);
    } catch {
      // topology.resolve 已 audit CROSS_CLAW_RESOLVE_FAILED；跳过此 claw。
      continue;
    }
    if (location.kind !== 'local') continue;
    const { delivered, failed } = await deliverForClaw(deps, clawId, location.clawDir, now);
    totalDelivered += delivered;
    totalFailed += failed;
  }
  return { delivered: totalDelivered, failed: totalFailed };
}

export function createWakeupDeliveryJob(
  deps: WakeupDeliveryJobDeps,
  globalConfig: CronJobGlobalConfig<'wakeup_delivery'>,
): CronJob {
  return {
    name: 'wakeup-delivery',
    enabled: globalConfig.cron.jobs.wakeup_delivery.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.wakeup_delivery.schedule, deps.audit),
    handler: async () => {
      await runWakeupDeliveryTick(deps);
    },
    timeoutMs: WAKEUP_DELIVERY_CRON_TIMEOUT_MS,
  } satisfies CronJob;
}
