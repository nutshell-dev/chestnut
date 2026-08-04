/**
 * phase 1287 Step C boundary fixture (negative): simulates a non-Watchdog
 * production module illegally deep-importing the layout owner
 * (watchdog/layout.js) to consume WATCHDOG_PATHS. Outside-owner consumers of
 * the layout protocol must be flagged by the boundary scanner.
 * （tests/ 不在 tsconfig include 内、fixture 只供 scanner 文本扫描。）
 */

import { WATCHDOG_PATHS } from '../../../../src/watchdog/layout.js';

// Reference the import so it is not flagged as unused while still being an illegal edge.
void WATCHDOG_PATHS;
