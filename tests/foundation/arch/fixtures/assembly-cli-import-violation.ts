/**
 * phase 1281 Step A boundary fixture (positive): simulates an Assembly module
 * illegally importing a CLIProcess module (cli/audit-events). After phase 1281
 * the only allowed Assembly→CLIProcess edge is
 * compose-config.ts → cli/commands/chat-viewport/config-schema.js; any other
 * edge like this one must be flagged by the boundary scanner.
 */

import { CLI_AUDIT_EVENTS } from '../../../../src/cli/audit-events.js';

// Reference the import so it is not flagged as unused while still being an illegal edge.
void CLI_AUDIT_EVENTS;
