// ============================================================================
// ClawForum Internal Constants
// ============================================================================
// Centralized location for L0 shared constants only.
// Domain-specific constants have been migrated to their owner modules
// (phase 814 Step B — P1.37 const namespace sweep).
// ============================================================================

import { type ClawId, makeClawId } from './core/claw-id.js';

export { type ClawId, makeClawId };

// ----------------------------------------------------------------------------
// System Identities
// ----------------------------------------------------------------------------

/** Motion claw identifier - the root orchestrator claw */
export const MOTION_CLAW_ID: ClawId = makeClawId('motion');

// ----------------------------------------------------------------------------
// Truncation Limits
// ----------------------------------------------------------------------------

/** Short UUID prefix length for human-readable IDs (`randomUUID().slice(0, 8)` pattern) */
export const UUID_SHORT_LEN = 8;
