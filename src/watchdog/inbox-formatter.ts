/**
 * @module L6.Watchdog
 * phase 1243 / Phase 1396 Step H: legacy compatibility inbox message declarations.
 *
 * Watchdog no longer produces `claw_crashed` or `claw_inactivity` messages.
 * These declarations exist only so that historical messages already on disk are
 * rendered as plain system messages by the generic Runtime formatter. They must
 * not be interpreted as current producer registration, guidance triggers, or
 * Motion prescriptions.
 */

import type { InboxMessageTypeDeclaration } from '../foundation/messaging/index.js';

export const WATCHDOG_INBOX_MESSAGE_TYPES = [
  {
    owner: 'watchdog',
    type: 'claw_crashed',
    rendering: { kind: 'standard', presentation: 'system' },
  },
  {
    owner: 'watchdog',
    type: 'claw_inactivity',
    rendering: { kind: 'standard', presentation: 'system' },
  },
] as const satisfies readonly InboxMessageTypeDeclaration[];
