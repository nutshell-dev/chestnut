/**
 * Caller type definitions
 * 
 * Centralized type definitions for all caller types to ensure consistency
 * across the codebase. New summon modes only need to be added here.
 */

import type { ToolProfile } from '../../foundation/tool-protocol/index.js';

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

