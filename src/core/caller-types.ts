/**
 * Caller type definitions
 * 
 * Centralized type definitions for all caller types to ensure consistency
 * across the codebase. New summon modes only need to be added here.
 */

import type { ToolProfile } from '../foundation/tool-protocol/index.js';
import type { ToolGroup } from '../foundation/tools/types.js';

export type DispatchCallerType = 'shadow' | 'miner';
export type CallerType = 'motion' | 'claw' | 'subagent' | 'verifier' | 'shadow' | 'miner';

/**
 * Map callerType to the corresponding ToolProfile for registry filtering.
 * Note: Main Claw doesn't use this path (runtime.ts uses 'full' profile directly),
 * so this only covers subagent scenarios.
 * shadow mirrors main agent's full toolset.
 */
export function callerTypeToProfile(callerType: string): ToolProfile {
  if (callerType === 'miner') return 'miner';
  if (callerType === 'shadow') return 'full';   // shadow mirrors main agent's full toolset
  return 'subagent';
}

/**
 * phase 1337 r138 D fork / L3 业务层 own CallerType → 允许 ToolGroup 集合映射。
 * L2c tools 框架不知 CallerType / 通过 ToolContext.allowedGroups 接收 group set。
 * Record<CallerType, ...> 编译期 exhaustive enforce 6 CallerType 全 cover.
 */
export const CALLER_TYPE_TO_GROUPS: Readonly<Record<CallerType, ReadonlySet<ToolGroup>>> = Object.freeze({
  motion: new Set<ToolGroup>(['fs-read', 'fs-write', 'spawn', 'audit', 'llm', 'cron', 'skill', 'messaging', 'memory', 'status', 'shadow', 'subagent-protocol']),
  claw:   new Set<ToolGroup>(['fs-read', 'fs-write', 'spawn', 'audit', 'llm', 'cron', 'skill', 'messaging', 'memory', 'status', 'shadow', 'subagent-protocol']),
  subagent: new Set<ToolGroup>(['fs-read', 'fs-write', 'audit', 'llm', 'skill', 'messaging', 'memory', 'status', 'subagent-protocol']),
  shadow: new Set<ToolGroup>(['fs-read', 'fs-write', 'audit', 'llm', 'skill', 'memory', 'status', 'subagent-protocol']),
  miner:  new Set<ToolGroup>(['fs-read', 'audit', 'llm', 'memory', 'subagent-protocol']),
  verifier: new Set<ToolGroup>(['fs-read', 'audit', 'llm', 'memory', 'subagent-protocol']),
});
