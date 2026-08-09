/**
 * phase 1284 Step B boundary fixture (negative): simulates a consumer legally
 * importing resolveDaemonEntry via the stable Daemon sub-entry
 * (daemon/entry-resolver.js). This edge must NOT be flagged by the boundary scanner.
 */

import { resolveDaemonEntry } from '../../../../src/daemon/index.js';

// Reference the import so it is not flagged as unused.
void resolveDaemonEntry;
