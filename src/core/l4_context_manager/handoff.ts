/**
 * @module L4.ContextManager
 * Sub-agent handoff marker protocol
 *
 * Marker does NOT copy dialog content — it only holds a ref.
 * Resolve reads on demand via parent round id.
 */

import { randomUUID } from 'node:crypto';
import {
  HANDOFF_MARKER_CREATED,
  HANDOFF_MARKER_NOT_FOUND,
} from './audit-events.js';
import type { AuditWriter } from './trim.js';

export interface HandoffMarker {
  id: string;                           // UUID
  parentRound: string;                  // parent agent round id
  createdAt: number;
  /** marker does not copy dialog content, only holds ref. resolve reads on demand. */
}

export function createHandoffMarker(parentRound: string, auditWriter?: AuditWriter): HandoffMarker {
  const marker: HandoffMarker = {
    id: randomUUID(),
    parentRound,
    createdAt: Date.now(),
  };
  auditWriter?.write(HANDOFF_MARKER_CREATED, `id=${marker.id}`, `parent=${marker.parentRound}`);
  return marker;
}

export function resolveHandoffMarker(id: string, auditWriter?: AuditWriter): HandoffMarker | null {
  // TBD: persistency strategy (in-memory map vs disk) to be decided in Step C
  void id;
  auditWriter?.write(HANDOFF_MARKER_NOT_FOUND, `id=${id}`);
  return null;
}
