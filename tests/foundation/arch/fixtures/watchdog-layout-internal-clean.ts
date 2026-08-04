/**
 * phase 1287 Step C boundary fixture (positive): simulates a Watchdog-internal
 * consumer legally importing WATCHDOG_PATHS via the module-local specifier
 * (./layout.js), the way watchdog-ownership.ts does. This edge must NOT be
 * flagged by the boundary scanner.
 */

import { WATCHDOG_PATHS } from './layout.js';

// Reference the import so it is not flagged as unused.
void WATCHDOG_PATHS;
