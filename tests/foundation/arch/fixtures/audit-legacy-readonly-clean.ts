/**
 * phase 1288 Step D boundary fixture (positive): simulates a compat reader
 * legally consuming AUDIT_LEGACY_PATHS.audit via the barrel for READ-ONLY
 * observation (existsSync/statSync only). This edge must NOT be flagged by
 * the legacy write-mutation scanner.
 */

import { AUDIT_LEGACY_PATHS } from '../../../../src/foundation/audit/index.js';

export function probe(fs: { existsSync(p: string): boolean }): boolean {
  return fs.existsSync(AUDIT_LEGACY_PATHS.audit);
}
