/**
 * phase 1279 Step A boundary fixture (negative): an Assembly module that touches
 * CLIProcess for a DIFFERENT, still-open edge (cli/audit-events CLI_FILE_ROUTING)
 * without any viewport routing reference. Scanner must not flag this file.
 */

import { CLI_FILE_ROUTING } from '../../../src/cli/audit-events.js';

void CLI_FILE_ROUTING;
