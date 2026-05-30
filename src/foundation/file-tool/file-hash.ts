/**
 * @module L2.FileTool
 * SHA-256 content hash helper for overwrite gate.
 *
 * phase 1430: introduced alongside FileState type for write/edit/multi_edit gate equality + mtime false-positive guard.
 * phase 1439: FileState type relocated to `tools/types.ts` (ML#5 cross-layer fix); this file isolated to pure hash utility.
 */

import { createHash } from 'crypto';

/** Compute SHA-256 hex digest of UTF-8 content (used for overwrite gate equality + mtime FP guard). */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
