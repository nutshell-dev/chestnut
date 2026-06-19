/**
 * @module L1.SharedConstants
 *
 * Centralized location for cross-module shared constants only.
 * Domain-specific constants belong in their owner modules
 * (phase 814 Step B — P1.37 const namespace sweep).
 */

import { type ClawId, makeClawId } from './foundation/identity/claw-id.js';

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
