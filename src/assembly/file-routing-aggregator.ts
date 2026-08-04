/**
 * Phase 159 / 1243 装配层 file 路由 aggregator.
 *
 * 按 phase 122 §5.A 业主声明 file 归属、装配层 aggregate.
 * audit 模块自身不 own routing logic (M#5).
 * phase 1243 Step B: Daemon routing 由外部 caller 作为 contribution 传入，删除 Assembly→Daemon import.
 * phase 1279 Step A: Viewport routing 归位真实 CLI 进程（Chat Viewport owner 工厂
 * createViewportAudit 兑现），删除 Assembly→CLIProcess viewport 边；daemon/Assembly
 * 零 viewport producer，此处不再聚合。`AuditFileName` 仍保留 'viewport'（CLI 侧物理 file）。
 */

import type { AuditFileName, AuditFileRoutingContribution } from '../foundation/audit/index.js';

// phase 159 立
import { CRON_FILE_ROUTING } from '../foundation/cron/index.js';
import { EVENTLOOP_FILE_ROUTING } from '../core/event-loop/index.js';

// phase 163 新加 14 业主
import { ASSEMBLY_FILE_ROUTING } from './audit-events.js';
import { ASSEMBLY_LLM_FILE_ROUTING } from './llm-audit-events.js';
import { CLI_FILE_ROUTING } from '../cli/audit-events.js';
import { CONTRACT_FILE_ROUTING } from '../core/contract/index.js';
import { GATEWAY_FILE_ROUTING } from '../core/gateway/index.js';
import { HEARTBEAT_FILE_ROUTING } from '../core/heartbeat/index.js';
import { MEMORY_FILE_ROUTING } from '../core/memory/index.js';
import { PERMISSIONS_FILE_ROUTING } from '../core/permissions/index.js';
import { SUBAGENT_FILE_ROUTING } from '../core/subagent/index.js';
import { MESSAGING_FILE_ROUTING } from '../foundation/messaging/index.js';
import { SNAPSHOT_FILE_ROUTING } from '../foundation/snapshot/index.js';
import { STREAM_FILE_ROUTING } from '../foundation/stream/index.js';
import { TOOLS_FILE_ROUTING } from '../foundation/tools/index.js';
import { WATCHDOG_FILE_ROUTING } from '../watchdog/watchdog.js';

export type FileName = AuditFileName;

export const DEFAULT_FILE: FileName = 'audit';

const INTERNAL_FILE_ROUTING: Readonly<Record<string, FileName>> = {
  // phase 159 立
  ...CRON_FILE_ROUTING,
  ...EVENTLOOP_FILE_ROUTING,
  // phase 163 新加
  ...ASSEMBLY_FILE_ROUTING,
  ...ASSEMBLY_LLM_FILE_ROUTING,
  ...CLI_FILE_ROUTING,
  ...CONTRACT_FILE_ROUTING,
  ...GATEWAY_FILE_ROUTING,
  ...HEARTBEAT_FILE_ROUTING,
  ...MEMORY_FILE_ROUTING,
  ...PERMISSIONS_FILE_ROUTING,
  ...SUBAGENT_FILE_ROUTING,
  ...MESSAGING_FILE_ROUTING,
  ...SNAPSHOT_FILE_ROUTING,
  ...STREAM_FILE_ROUTING,
  ...TOOLS_FILE_ROUTING,
  ...WATCHDOG_FILE_ROUTING,
} as const;

/**
 * 聚合内部 routing 与外部 caller 贡献的 routing。
 * external 后写入，last-win 与起步行为一致。
 */
export function createAggregatedFileRouting(
  external?: readonly AuditFileRoutingContribution[],
): ReadonlyMap<string, FileName> {
  const map = new Map<string, FileName>(Object.entries(INTERNAL_FILE_ROUTING));
  if (external) {
    for (const contribution of external) {
      for (const [type, file] of Object.entries(contribution)) {
        map.set(type, file);
      }
    }
  }
  return map;
}

/**
 * 默认聚合（无外部 contribution），供独立测试/直接消费使用。
 * 注意：phase 1243 后 daemon_liveness_heartbeat 等 Daemon 路由不在默认图中，
 * 须由 daemon-entry 传入 contribution 后调用 createAggregatedFileRouting。
 */
export const AggregatedFileRouting: ReadonlyMap<string, FileName> = createAggregatedFileRouting();

/**
 * Lookup file for a given event type.
 * Returns DEFAULT_FILE ('audit') if type not in aggregated routing.
 */
export function lookupFileForType(
  type: string,
  routing: ReadonlyMap<string, FileName> = AggregatedFileRouting,
): FileName {
  return routing.get(type) ?? DEFAULT_FILE;
}

/**
 * Get distinct file names in the routing (always includes DEFAULT_FILE).
 */
export function getRoutedFileNames(
  routing: ReadonlyMap<string, FileName> = AggregatedFileRouting,
): ReadonlySet<FileName> {
  return new Set([DEFAULT_FILE, ...routing.values()]);
}
