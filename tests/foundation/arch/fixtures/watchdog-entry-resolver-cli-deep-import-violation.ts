/**
 * phase 1285 Step B boundary fixture (positive): simulates a CLI consumer illegally
 * deep-importing the internal resolver (watchdog/entry-resolver.js) instead of the
 * public zero-arg query getWatchdogEntryPath(). External consumers must go through
 * the Watchdog public surface; deep import of the internal resolver must be flagged.
 * （tests/ 不在 tsconfig include 内、fixture 只供 scanner 文本扫描。）
 */

import { resolveWatchdogEntry } from '../../../../src/watchdog/entry-resolver.js';

// Reference the import so it is not flagged as unused while still being an illegal edge.
void resolveWatchdogEntry;
