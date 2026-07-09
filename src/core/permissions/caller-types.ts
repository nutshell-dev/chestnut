/**
 * Caller type definitions
 * 
 * Centralized type definitions for all caller types to ensure consistency
 * across the codebase. New summon modes only need to be added here.
 */

import type { ToolProfile } from '../../foundation/tool-protocol/index.js';

export type DispatchCallerType = 'shadow_subagent' | 'miner_subagent';
export type CallerType = 'motion' | 'claw' | 'spawn_subagent' | 'verifier' | 'shadow_subagent' | 'miner_subagent';

/**
 * Map callerType to the corresponding ToolProfile for registry filtering.
 * Note: Main Claw doesn't use this path (runtime.ts uses 'full' profile directly),
 * so this only covers subagent scenarios.
 * shadow mirrors main agent's full toolset.
 */
export function callerTypeToProfile(callerType: string): ToolProfile {
  if (callerType === 'miner_subagent') return 'miner';
  if (callerType === 'shadow_subagent') return 'full';   // shadow mirrors main agent's full toolset
  return 'subagent';  // default: spawn_subagent and other unrecognized values
}

