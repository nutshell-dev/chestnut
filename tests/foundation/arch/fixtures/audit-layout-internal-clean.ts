/**
 * phase 1288 Step B boundary fixture (positive): simulates an AuditLog-internal
 * consumer legally importing AUDIT_PATHS via the module-local specifier
 * (./layout.js), the way workspace-config.ts / migration-journal.ts do.
 * This edge must NOT be flagged by the boundary scanner.
 */

import { AUDIT_PATHS } from './layout.js';

// Reference the import so it is not flagged as unused.
void AUDIT_PATHS;
