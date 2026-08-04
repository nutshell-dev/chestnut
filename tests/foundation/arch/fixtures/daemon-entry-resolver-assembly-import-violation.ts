/**
 * phase 1284 Step B boundary fixture (positive): simulates a consumer illegally
 * importing resolveDaemonEntry from the old Assembly path. After phase 1284 the
 * daemon entry resolver is owned by Daemon (daemon/entry-resolver.ts) — any import
 * via assembly/spawn-entry must be flagged by the boundary scanner.
 * （tests/ 不在 tsconfig include 内、fixture 只供 scanner 文本扫描，旧路径符号已不存在。）
 */

import { resolveDaemonEntry } from '../../../../src/assembly/spawn-entry.js';

// Reference the import so it is not flagged as unused while still being an illegal edge.
void resolveDaemonEntry;
