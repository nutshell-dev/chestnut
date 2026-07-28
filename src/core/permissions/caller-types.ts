/**
 * callerType → toolProfile mapping.
 *
 * CallerType is now owned by AsyncTaskSystem (phase 1224).
 * This function is retained for subagent-executor's local copy only.
 */
import type { ToolProfile } from '../../foundation/tool-protocol/index.js';

export function callerTypeToProfile(callerType: string): ToolProfile {
  if (callerType === 'miner_subagent') return 'miner';
  if (callerType === 'shadow_subagent') return 'full';
  return 'subagent';
}

