/**
 * phase 1288 Step B boundary fixture (negative): simulates a non-AuditLog
 * production module illegally deep-importing the layout owner
 * (foundation/audit/layout.js) to consume AUDIT_PATHS. Outside-owner consumers
 * must go through the audit barrel (foundation/audit/index.js); deep imports
 * must be flagged by the boundary scanner.
 * （tests/ 不在 tsconfig include 内、fixture 只供 scanner 文本扫描。）
 */

import { AUDIT_PATHS } from '../../../../src/foundation/audit/layout.js';

// Reference the import so it is not flagged as unused while still being an illegal edge.
void AUDIT_PATHS;
