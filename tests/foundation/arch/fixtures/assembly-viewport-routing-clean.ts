/**
 * phase 1281 Step A boundary fixture (negative): an Assembly module with zero
 * CLIProcess imports. Before phase 1281 it simulated the retired CLI_FILE_ROUTING
 * edge as "another allowed CLI edge"; that edge was deleted, so the fixture is
 * now truly clean — only a non-CLI edge (cron routing, legitimately aggregated
 * by Assembly) remains. Both the viewport routing scanner and the
 * Assembly→CLIProcess boundary scanner must ignore this file.
 */

import { CRON_FILE_ROUTING } from '../../../../src/foundation/cron/index.js';

void CRON_FILE_ROUTING;
