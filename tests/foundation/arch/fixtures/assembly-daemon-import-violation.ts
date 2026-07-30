/**
 * phase 1243 Step F ratchet fixture: simulates an Assembly module illegally importing Daemon.
 * This file intentionally violates the Assembly→Daemon direction rule for test verification.
 */

import { DAEMON_FILE_ROUTING } from '../../../src/daemon/index.js';

// Reference the import so it is not flagged as unused while still being an illegal cross-module import.
void DAEMON_FILE_ROUTING;
