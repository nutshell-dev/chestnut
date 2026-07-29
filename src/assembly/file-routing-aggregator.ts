/**
 * Phase 159 装配层 file 路由 aggregator.
 *
 * 按 phase 122 §5.A 业主声明 file 归属、装配层 aggregate.
 * audit 模块自身不 own routing logic (M#5).
 */

// phase 159 立
import { CRON_FILE_ROUTING } from '../foundation/cron/index.js';
import { DAEMON_FILE_ROUTING } from '../daemon/index.js';
import { EVENTLOOP_FILE_ROUTING } from '../core/event-loop/index.js';
import { VIEWPORT_FILE_ROUTING } from '../cli/commands/viewport-audit-events.js';

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

export type FileName = 'audit' | 'tick' | 'viewport';

export const DEFAULT_FILE: FileName = 'audit';

export const AggregatedFileRouting: ReadonlyMap<string, FileName> = new Map([
  // phase 159 立
  ...Object.entries(CRON_FILE_ROUTING),
  ...Object.entries(DAEMON_FILE_ROUTING),
  ...Object.entries(EVENTLOOP_FILE_ROUTING),
  ...Object.entries(VIEWPORT_FILE_ROUTING),
  // phase 163 新加
  ...Object.entries(ASSEMBLY_FILE_ROUTING),
  ...Object.entries(ASSEMBLY_LLM_FILE_ROUTING),
  ...Object.entries(CLI_FILE_ROUTING),
  ...Object.entries(CONTRACT_FILE_ROUTING),
  ...Object.entries(GATEWAY_FILE_ROUTING),
  ...Object.entries(HEARTBEAT_FILE_ROUTING),
  ...Object.entries(MEMORY_FILE_ROUTING),
  ...Object.entries(PERMISSIONS_FILE_ROUTING),
  ...Object.entries(SUBAGENT_FILE_ROUTING),
  ...Object.entries(MESSAGING_FILE_ROUTING),
  ...Object.entries(SNAPSHOT_FILE_ROUTING),
  ...Object.entries(STREAM_FILE_ROUTING),
  ...Object.entries(TOOLS_FILE_ROUTING),
  ...Object.entries(WATCHDOG_FILE_ROUTING),
] as [string, FileName][]);

/**
 * Lookup file for a given event type.
 * Returns DEFAULT_FILE ('audit') if type not in aggregated routing.
 */
export function lookupFileForType(type: string): FileName {
  return AggregatedFileRouting.get(type) ?? DEFAULT_FILE;
}

/**
 * Get distinct file names in the routing (always includes DEFAULT_FILE).
 */
export function getRoutedFileNames(): ReadonlySet<FileName> {
  return new Set([DEFAULT_FILE, ...AggregatedFileRouting.values()]);
}
