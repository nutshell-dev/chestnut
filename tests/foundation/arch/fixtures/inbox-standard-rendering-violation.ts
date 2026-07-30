/**
 * phase 1243 Step F ratchet fixture: a business owner re-introducing the standard
 * system passthrough formatter instead of using the standard rendering declaration.
 */

import type { MessageFormatter } from '../../../src/foundation/messaging/index.js';

export const formatViolation: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;
