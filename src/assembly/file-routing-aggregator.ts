/**
 * Phase 159 装配层 file 路由 aggregator.
 *
 * 按 phase 122 §5.A 业主声明 file 归属、装配层 aggregate.
 * audit 模块自身不 own routing logic (M#5).
 */

import { CRON_FILE_ROUTING } from '../core/cron/audit-events.js';
import { DAEMON_FILE_ROUTING } from '../daemon/audit-events.js';
import { VIEWPORT_FILE_ROUTING } from '../cli/commands/viewport-audit-events.js';

export type FileName = 'audit' | 'tick' | 'viewport';

export const DEFAULT_FILE: FileName = 'audit';

export const AggregatedFileRouting: ReadonlyMap<string, FileName> = new Map([
  ...Object.entries(CRON_FILE_ROUTING),
  ...Object.entries(DAEMON_FILE_ROUTING),
  ...Object.entries(VIEWPORT_FILE_ROUTING),
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
