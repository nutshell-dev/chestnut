/**
 * phase 1281 Step A boundary fixture (positive): simulates an Assembly module
 * illegally importing a CLIProcess module (cli/audit-events). After phase 1283
 * Step B the Assembly→CLIProcess boundary is a zero-edge ban — any edge like
 * this one must be flagged by the boundary scanner.
 */

import { CLI_AUDIT_EVENTS } from '../../../../src/cli/audit-events.js';

// Reference the import so it is not flagged as unused while still being an illegal edge.
void CLI_AUDIT_EVENTS;
