/**
 * phase 1285 Step B boundary fixture (negative): simulates a Watchdog-internal
 * consumer legally importing resolveWatchdogEntry via the module-local specifier
 * (./entry-resolver.js), the way watchdog-context.ts does. This edge must NOT be
 * flagged by the boundary scanner.
 */

import { resolveWatchdogEntry } from './entry-resolver.js';

// Reference the import so it is not flagged as unused.
void resolveWatchdogEntry;
