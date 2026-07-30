/**
 * phase 1247 Step E ratchet fixture: simulates a Daemon module illegally importing Watchdog.
 * This file intentionally violates the Daemon→Watchdog direction rule for test verification.
 */

import { ensureWatchdog } from '../../../src/watchdog/ensure.js';

// Reference the import so it is not flagged as unused while still being an illegal cross-module import.
void ensureWatchdog;
