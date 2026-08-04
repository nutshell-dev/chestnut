/**
 * phase 1288 Step D boundary fixture (negative): simulates production code
 * illegally WRITING the legacy root audit path (AUDIT_LEGACY_PATHS.audit).
 * Legacy is read-only in this phase — any write/append/move/delete token
 * next to the legacy reference must be flagged by the scanner.
 * （tests/ 不在 tsconfig include 内、fixture 只供 scanner 文本扫描。）
 */

import { AUDIT_LEGACY_PATHS } from '../../../../src/foundation/audit/index.js';

export function illegalAppend(fs: { appendFileSync(p: string, s: string): void }): void {
  fs.appendFileSync(AUDIT_LEGACY_PATHS.audit, 'forbidden\n');
}
