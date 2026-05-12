/**
 * Caller type definitions
 * 
 * Centralized type definitions for all caller types to ensure consistency
 * across the codebase. New dispatch modes only need to be added here.
 */

import type { ToolProfile } from '../../types/config.js';

export type DispatchCallerType = 'describer' | 'miner';
export type CallerType = 'claw' | 'subagent' | 'verifier' | DispatchCallerType;

/**
 * Map callerType to the corresponding ToolProfile for registry filtering.
 * Note: Main Claw doesn't use this path (runtime.ts uses 'full' profile directly),
 * so this only covers subagent scenarios.
 */
export function callerTypeToProfile(callerType: string): ToolProfile {
  return callerType === 'miner' ? 'miner' : 'subagent';
}
